// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// macOS uses the CEF (Chromium) runtime. CEF relaunches this same binary with a
// `--type=` switch for its helper (renderer/GPU/network/utility) processes; the
// attribute runs those and returns before the Tauri app is built. On Windows/Linux
// (wry) there is no such helper, so a plain main is used.
#[cfg(target_os = "macos")]
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    ai_dev_terminal_lib::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    ai_dev_terminal_lib::run()
}
