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
    /// The BROWSER-level CDP WebSocket URL — the frontend connects here and attaches to a
    /// page via the Target domain (robust across Chrome versions).
    pub ws_url: String,
}

/// Minimal HTTP GET to the local DevTools HTTP endpoint (no dependency on an HTTP crate —
/// it's plain localhost HTTP/1.1). Returns the response body.
///
/// Reads the body by Content-Length and stops as soon as it's complete. It must NOT wait
/// for EOF (the old `read_to_string` did): Chrome's DevTools HTTP server keeps the socket
/// alive and ignores our `Connection: close`, so there is no EOF — the read just blocks
/// until the timeout and fails with EAGAIN ("Resource temporarily unavailable", os error
/// 35), which looked like "no browser WebSocket".
fn http_get(port: u16, path: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(body) = complete_body(&buf) {
            return Ok(body);
        }
        match stream.read(&mut chunk) {
            Ok(0) => break, // EOF (server did close)
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            // Timed out / would block: stop and use whatever we have below.
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    // EOF or a read timeout with data already in hand: return the full-length body if we
    // have it, else whatever followed the header break (covers a close-delimited body).
    complete_body(&buf)
        .or_else(|| {
            let sep = b"\r\n\r\n";
            buf.windows(sep.len())
                .position(|w| w == sep)
                .map(|p| String::from_utf8_lossy(&buf[p + sep.len()..]).into_owned())
        })
        .ok_or_else(|| "malformed/empty HTTP response from DevTools endpoint".into())
}

/// If `buf` holds complete headers plus a Content-Length worth of body, return the body.
/// None means "not all here yet" — keep reading.
fn complete_body(buf: &[u8]) -> Option<String> {
    let sep = b"\r\n\r\n";
    let pos = buf.windows(sep.len()).position(|w| w == sep)?;
    let head = std::str::from_utf8(&buf[..pos]).ok()?;
    let clen: usize = head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        if k.trim().eq_ignore_ascii_case("content-length") {
            v.trim().parse::<usize>().ok()
        } else {
            None
        }
    })?;
    let body = &buf[pos + sep.len()..];
    if body.len() >= clen {
        Some(String::from_utf8_lossy(&body[..clen]).into_owned())
    } else {
        None
    }
}

/// Read the chosen debugging port from the profile's DevToolsActivePort file (written by
/// Chrome when launched with --remote-debugging-port=0). First line is the port.
fn read_active_port(dir: &PathBuf) -> Option<u16> {
    let txt = std::fs::read_to_string(dir.join("DevToolsActivePort")).ok()?;
    txt.lines().next()?.trim().parse().ok()
}

/// The BROWSER-level CDP WebSocket URL from /json/version. Always present, and version-robust
/// — the frontend attaches to a page via the Target domain (newer Chrome may report the page
/// as type "tab" in /json/list, so scanning for type "page" there is unreliable).
fn find_browser_ws(port: u16) -> Result<String, String> {
    let body = http_get(port, "/json/version")?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    v.get("webSocketDebuggerUrl")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no browser WebSocket in /json/version".into())
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

    // Two SEPARATE wait windows (they used to share one 15s deadline — a slow port file
    // could starve the ws step and wrongly report "no browser WebSocket"). First: wait for
    // the profile's DevToolsActivePort file.
    let port_deadline = Instant::now() + Duration::from_secs(15);
    let mut port = None;
    while Instant::now() < port_deadline {
        if let Some(p) = read_active_port(&profile) {
            port = Some(p);
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let port = port.ok_or("browser did not expose a debugging port in time (did Chrome start?)")?;

    // Second: resolve the browser-level ws URL from /json/version. Keep the LAST real error
    // (connection refused, malformed response, …) and surface it — the old code discarded it
    // and always reported the generic "no browser WebSocket", which hid the actual cause.
    let ws_deadline = Instant::now() + Duration::from_secs(15);
    let ws_url = loop {
        match find_browser_ws(port) {
            Ok(ws) => break ws,
            Err(e) => {
                if Instant::now() >= ws_deadline {
                    return Err(format!("no browser WebSocket on port {port}: {e}"));
                }
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    };

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
