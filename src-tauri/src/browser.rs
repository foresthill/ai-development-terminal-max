//! CDP browser layer, stage C1 (方式A): detect the user's own Chrome/Chromium, launch it
//! headed in a separate OS window with a remote-debugging port, and hand the frontend the
//! page's CDP WebSocket URL. `src/browser-controller.ts` then drives it over CDP (navigate,
//! accessibility tree, click/type) — see docs/2026-09-27-browser-controller-design.md and
//! docs/2026-11-16-editor-and-browser-cdp.md. Validated first in spike/browser-cdp.
//!
//! Zero bundled browser (方式A): nothing ships, we reuse the installed Chrome. C2 will embed
//! the page via Page.startScreencast; C1 just proves "the AI can touch elements".

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

/// Per-OS candidate paths for a Chromium-family browser, most-preferred first.
fn chrome_candidates() -> Vec<&'static str> {
    #[cfg(target_os = "macos")]
    {
        vec![
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
    }
    #[cfg(target_os = "windows")]
    {
        vec![
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        ]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        vec![
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/usr/bin/brave-browser",
        ]
    }
}

fn detect_chrome() -> Option<String> {
    chrome_candidates()
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|s| s.to_string())
}

/// True if a Chromium-family browser is installed (the UI can hide the CDP option otherwise).
#[tauri::command]
pub fn browser_detect() -> Option<String> {
    detect_chrome()
}

#[derive(serde::Serialize)]
pub struct LaunchInfo {
    pub pid: u32,
    pub port: u16,
    /// The page target's CDP WebSocket URL — the frontend connects to this directly.
    pub ws_url: String,
}

/// Minimal HTTP GET to the local DevTools HTTP endpoint (no dependency on an HTTP crate —
/// it's plain localhost HTTP/1.1). Returns the response body.
fn http_get(port: u16, path: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    // Split headers from body at the blank line.
    match buf.split_once("\r\n\r\n") {
        Some((_, body)) => Ok(body.to_string()),
        None => Err("malformed HTTP response from DevTools endpoint".into()),
    }
}

/// Read the chosen debugging port from the profile's DevToolsActivePort file (written by
/// Chrome when launched with --remote-debugging-port=0). First line is the port.
fn read_active_port(dir: &PathBuf) -> Option<u16> {
    let txt = std::fs::read_to_string(dir.join("DevToolsActivePort")).ok()?;
    txt.lines().next()?.trim().parse().ok()
}

/// Find the first "page" target's webSocketDebuggerUrl from /json/list.
fn find_page_ws(port: u16) -> Result<String, String> {
    let body = http_get(port, "/json/list")?;
    let targets: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let arr = targets.as_array().ok_or("unexpected /json/list shape")?;
    for t in arr {
        if t.get("type").and_then(|v| v.as_str()) == Some("page") {
            if let Some(ws) = t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                return Ok(ws.to_string());
            }
        }
    }
    Err("no page target found".into())
}

/// Launch the user's Chrome with a remote-debugging port in a throwaway profile (so it
/// won't clash with the user's running Chrome and never touches their real profile), and
/// return the page's CDP WebSocket URL for the frontend to attach to. `headless` picks the
/// mode: false = headed in its own window (C1, separate-window PoC); true = headless, so
/// the page is shown only via Page.startScreencast inside the app (C2, embedded).
#[tauri::command]
pub fn browser_launch(url: String, headless: bool) -> Result<LaunchInfo, String> {
    let exe = detect_chrome().ok_or("no Chrome/Chromium/Edge/Brave found")?;

    // Throwaway profile under the OS temp dir, unique per launch.
    let profile = std::env::temp_dir().join(format!(
        "aidt-cdp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&exe);
    cmd.arg("--remote-debugging-port=0")
        // Allow the webview origin to open the DevTools WebSocket (required since Chrome 111).
        .arg("--remote-allow-origins=*")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        // Don't touch the OS keychain/secret store for this throwaway automation profile
        // (avoids the macOS "Chromium Safe Storage" keychain prompt). Standard for
        // CDP-driven browsers (Playwright/Puppeteer use the same).
        .arg("--password-store=basic")
        .arg("--use-mock-keychain");
    if headless {
        cmd.arg("--headless=new");
    } else {
        cmd.arg("--new-window");
    }
    let child = cmd
        .arg(&url)
        .spawn()
        .map_err(|e| format!("{exe}: {e}"))?;
    let pid = child.id();

    // Wait for the profile's DevToolsActivePort, then resolve the page target's ws URL.
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut port = None;
    while Instant::now() < deadline {
        if let Some(p) = read_active_port(&profile) {
            port = Some(p);
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let port = port.ok_or("browser did not expose a debugging port in time")?;

    let mut ws_url = Err("no page target".to_string());
    while Instant::now() < deadline {
        match find_page_ws(port) {
            Ok(ws) => {
                ws_url = Ok(ws);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(150)),
        }
    }
    let ws_url = ws_url?;

    Ok(LaunchInfo { pid, port, ws_url })
}

/// Kill a browser process previously launched by browser_launch (best-effort).
#[tauri::command]
pub fn browser_close(pid: u32) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        // SAFETY: a plain kill(2) by pid; errors (already-exited) are ignored.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
