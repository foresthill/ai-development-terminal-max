//! Minimal file read/write for the in-app editor layer (the macOS 26 way to edit, since
//! terminal vim can't repaint there — see docs/2026-10-24-macos26-wkwebview-altscreen.md).
//! Deliberately simple: the editor opens a path the user picked (dialog) or ⌘-clicked in
//! a terminal, so there is no sandboxing beyond the OS user's own permissions.

/// Read a UTF-8 text file. Returns its contents, or an error string the UI can toast.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// One entry of a directory listing for the in-app file browser (files-panel.ts).
#[derive(serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// List a directory (read-only), directories first then files, each case-insensitively
/// sorted. Powers the in-app file browser: pick a file to open it in the editor layer.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry { name, is_dir });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
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
