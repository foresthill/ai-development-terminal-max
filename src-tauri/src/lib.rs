mod claude_sessions;
mod files;
mod git;
mod memory;
mod pty;
mod subagent;
mod sys;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Tauri 3: pick the webview runtime per platform. macOS → CEF (Chromium) to fix
    // wry#1848 (vim freeze on macOS 26); everything else → wry (system webview).
    #[cfg(target_os = "macos")]
    let base = tauri::Builder::default().runtime(tauri_runtime_cef::Cef::default());
    #[cfg(not(target_os = "macos"))]
    let base = tauri::Builder::default().runtime(tauri_runtime_wry::Wry::default());

    #[allow(unused_mut)]
    let mut builder = base
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    // Auto-update + relaunch are desktop-only plugins.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    builder
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
            pty::shell_login_args,
            pty::home_dir,
            git::is_git_repo,
            git::current_branch,
            git::git_clone,
            git::create_worktree,
            git::write_aidt_settings,
            sys::agent_stats,
            sys::alt_screen_broken,
            sys::platform_os,
            files::read_file,
            files::write_file,
            memory::memory_read_all,
            memory::memory_write_all,
            claude_sessions::claude_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
