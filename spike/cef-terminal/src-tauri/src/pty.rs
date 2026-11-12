//! Minimal PTY bridge for the CEF spike — trimmed copy of the main app's src-tauri/
//! src/pty.rs. Spawns a shell in a pseudo-terminal and streams its output to the
//! frontend over a Tauri Channel. Enough to run `vim` and see whether CEF (Chromium)
//! repaints a full-screen TUI on macOS 26 where WKWebView does not (wry#1848).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::Emitter;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry(Mutex<HashMap<String, PtySession>>);

#[cfg(unix)]
fn child_is_alive(pid: u32) -> bool {
    pid != 0 && unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
}
#[cfg(not(unix))]
fn child_is_alive(_pid: u32) -> bool {
    false
}

#[tauri::command]
pub fn spawn_pty(
    app: tauri::AppHandle,
    registry: tauri::State<'_, PtyRegistry>,
    id: String,
    shell: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<String>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("SHELL_SESSIONS_DISABLE", "1");
    ensure_utf8_locale(&mut cmd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn failed: {e}"))?;
    let pid = child.process_id().unwrap_or(0);

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("take writer failed: {e}"))?;

    let channel = on_output.clone();
    let exit_id = id.clone();
    let child_pid = pid;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut errs = 0u32;
        let reason;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    reason = "eof";
                    break;
                }
                Ok(n) => {
                    errs = 0;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if channel.send(encoded).is_err() {
                        reason = "channel";
                        break;
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue;
                }
                Err(_) => {
                    let alive = child_is_alive(child_pid);
                    errs += 1;
                    if alive && errs < 50 {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    reason = "err";
                    break;
                }
            }
        }
        let _ = app.emit("pty-exit", format!("{exit_id}|{reason}"));
    });

    registry.0.lock().unwrap().insert(id, PtySession { master: pair.master, writer, child });
    Ok(pid)
}

fn ensure_utf8_locale(cmd: &mut CommandBuilder) {
    let already = ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| {
        std::env::var(k)
            .map(|v| {
                let u = v.to_ascii_uppercase();
                u.contains("UTF-8") || u.contains("UTF8")
            })
            .unwrap_or(false)
    });
    if already {
        return;
    }
    cmd.env("LANG", "en_US.UTF-8");
}

#[tauri::command]
pub fn write_pty(registry: tauri::State<'_, PtyRegistry>, id: String, data: String) -> Result<(), String> {
    let mut map = registry.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("unknown pty id")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    session.writer.flush().map_err(|e| format!("flush failed: {e}"))
}

#[tauri::command]
pub fn resize_pty(registry: tauri::State<'_, PtyRegistry>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = registry.0.lock().unwrap();
    let session = map.get(&id).ok_or("unknown pty id")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize failed: {e}"))
}

#[tauri::command]
pub fn kill_pty(registry: tauri::State<'_, PtyRegistry>, id: String) -> Result<(), String> {
    if let Some(mut session) = registry.0.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

#[tauri::command]
pub fn shell_login_args() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        Vec::new()
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["-l".to_string()]
    }
}

#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}
