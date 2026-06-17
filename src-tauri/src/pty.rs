//! PTY bridge: spawns real shells / `claude` processes in pseudo-terminals and
//! streams their output to the frontend over a per-session Tauri Channel.
//!
//! One [`PtySession`] per terminal layer. The frontend owns the lifecycle:
//! `spawn_pty` -> `write_pty` / `resize_pty` -> `kill_pty`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

/// A single live pseudo-terminal: its master (for resize), an input writer, and
/// the child process handle (for kill). The reader runs on a detached thread.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Global registry of live sessions, keyed by the frontend-supplied id.
#[derive(Default)]
pub struct PtyRegistry(Mutex<HashMap<String, PtySession>>);

/// Spawn a new PTY running `shell` (with `args`) in `cwd`. Output chunks are
/// base64-encoded and pushed through `on_output` as they arrive.
#[tauri::command]
pub fn spawn_pty(
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
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
    }
    // Make terminal-aware programs (including claude) render full UI.
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    let pid = child.process_id().unwrap_or(0);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    // Detached reader thread: pump master output into the channel until EOF.
    let channel = on_output.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if channel.send(encoded).is_err() {
                        break;
                    }
                }
            }
        }
    });

    registry.0.lock().unwrap().insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(pid)
}

/// Forward user keystrokes (raw UTF-8) to the PTY.
#[tauri::command]
pub fn write_pty(
    registry: tauri::State<'_, PtyRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut map = registry.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("unknown pty id")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    session.writer.flush().map_err(|e| format!("flush failed: {e}"))
}

/// Resize the PTY when its layer changes size (focus zoom, window resize, etc.).
#[tauri::command]
pub fn resize_pty(
    registry: tauri::State<'_, PtyRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = registry.0.lock().unwrap();
    let session = map.get(&id).ok_or("unknown pty id")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))
}

/// The user's login shell, used as the default program for new terminals.
#[tauri::command]
pub fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

/// The user's home directory, used as the default cwd for new terminals.
#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

/// Kill the child process and drop the session.
#[tauri::command]
pub fn kill_pty(registry: tauri::State<'_, PtyRegistry>, id: String) -> Result<(), String> {
    if let Some(mut session) = registry.0.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}
