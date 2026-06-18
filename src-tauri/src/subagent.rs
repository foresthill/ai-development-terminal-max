//! Subagent detection. Claude Code SubagentStart/Stop hooks (installed per
//! worktree) append their JSON payload to ~/.aidt/subagent-events.jsonl. This
//! watcher tails that file and re-emits each event to the frontend, which pops a
//! nested card for the running subagent. See code.claude.com/docs/en/hooks.md
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

fn events_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".aidt").join("subagent-events.jsonl")
}

/// Spawn a background thread that tails the events file and emits a "subagent"
/// event per new line. Starts at EOF so old events are not replayed.
pub fn start_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let path = events_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let mut offset: u64 = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let Ok(mut f) = std::fs::File::open(&path) else {
                continue;
            };
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            if len < offset {
                offset = 0; // file was truncated/rotated
            }
            if len == offset {
                continue;
            }
            if f.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut buf = String::new();
            if f.read_to_string(&mut buf).is_err() {
                continue;
            }
            offset = len;
            for line in buf.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    let _ = app.emit("subagent", v);
                }
            }
        }
    });
}
