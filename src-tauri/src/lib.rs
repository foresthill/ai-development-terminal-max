mod git;
mod pty;
mod subagent;
mod sys;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyRegistry::default())
        .manage(sys::SysState::default())
        .setup(|app| {
            subagent::start_watch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            pty::default_shell,
            pty::home_dir,
            git::is_git_repo,
            git::current_branch,
            git::git_clone,
            git::create_worktree,
            git::write_aidt_settings,
            sys::agent_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
