// Prevents an extra console window on Windows in release. DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// CEF relaunches this same binary with a `--type=` switch for its helper (renderer /
// GPU / network / utility) processes. The attribute runs those and returns BEFORE the
// Tauri app is built, so helpers never create windows. Must sit on the real entry point.
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    cef_terminal_lib::run();
}
