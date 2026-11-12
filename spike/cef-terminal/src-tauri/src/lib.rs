//! CEF spike entry. Selects the Chromium (CEF) runtime so a full-screen TUI (vim)
//! renders on macOS 26, where the system WKWebView (wry) does not (wry#1848).

mod pty;

pub fn run() {
    tauri::Builder::default()
        // Tauri 3.0: the webview runtime is chosen here, not via a Cargo feature.
        .runtime(tauri_runtime_cef::Cef::default())
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            pty::default_shell,
            pty::shell_login_args,
            pty::home_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
