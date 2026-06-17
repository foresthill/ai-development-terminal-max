mod git;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            pty::default_shell,
            pty::home_dir,
            git::is_git_repo,
            git::git_clone,
            git::create_worktree,
            git::write_guardrails,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
