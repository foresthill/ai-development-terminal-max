//! Minimal file read/write for the in-app editor layer (the macOS 26 way to edit, since
//! terminal vim can't repaint there — see docs/2026-10-24-macos26-wkwebview-altscreen.md).
//! Deliberately simple: the editor opens a path the user picked (dialog) or ⌘-clicked in
//! a terminal, so there is no sandboxing beyond the OS user's own permissions.

/// Read a UTF-8 text file. Returns its contents, or an error string the UI can toast.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Write a UTF-8 text file (create or overwrite), creating parent dirs as needed.
#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
    }
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}
