import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./app";
import { applyStatic } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { setDisableAltScreen } from "./terminal-guards";
import { installNavGuard } from "./nav-guard";
import { initCanonicalStore } from "./memory";

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
  // Mark the OS so CSS can enable the translucent (vibrancy) window background only
  // on macOS — on Windows/Linux the body stays opaque so a transparent window never
  // shows through to the desktop. See styles.css :root[data-os="macos"].
  try {
    document.documentElement.dataset.os = await invoke<string>("platform_os");
  } catch {
    /* non-Tauri — leave unset (opaque, safe default) */
  }
  // Promote memory to its canonical SQLite store before the UI reads it (migrates
  // any existing localStorage memories in once). No-op/ fallback outside Tauri.
  await initCanonicalStore();
  const app = new App(document.getElementById("root")!);
  app.init();
}

void boot();
