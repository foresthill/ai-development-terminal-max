import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./app";
import { applyStatic } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { setDisableAltScreen } from "./terminal-guards";

// Decide the macOS 26 alt-screen workaround BEFORE any terminal is created. The Rust
// `alt_screen_broken` command returns true only on an affected host (macOS 26 release);
// elsewhere full-screen TUIs keep the normal alt-screen. See terminal-guards.ts.
async function boot() {
  applyStatic();
  try {
    setDisableAltScreen(await invoke<boolean>("alt_screen_broken"));
  } catch {
    /* non-Tauri context (e.g. web preview) — keep alt-screen enabled */
  }
  const app = new App(document.getElementById("root")!);
  app.init();
}

void boot();
