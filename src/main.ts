import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./app";
import { applyStatic } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { setDisableAltScreen } from "./terminal-guards";
import { installNavGuard } from "./nav-guard";

// Decide the macOS 26 alt-screen workaround BEFORE any terminal is created. The Rust
// `alt_screen_broken` command returns true only on an affected host (macOS 26 release);
// elsewhere full-screen TUIs keep the normal alt-screen. See terminal-guards.ts.
async function boot() {
  applyStatic();
  // Stop any stray top-level navigation from blowing away the SPA (and every live
  // terminal) — see nav-guard.ts. Install before the UI so it covers the first click.
  installNavGuard();
  try {
    setDisableAltScreen(await invoke<boolean>("alt_screen_broken"));
  } catch {
    /* non-Tauri context (e.g. web preview) — keep alt-screen enabled */
  }
  const app = new App(document.getElementById("root")!);
  app.init();
}

void boot();
