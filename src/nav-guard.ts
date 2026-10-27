// Navigation guard: this app is a single-page Tauri webview that must NEVER
// navigate the top-level document away — doing so destroys the whole JS context
// and every live terminal/PTY with it, which looks like the app "crashing and
// reloading". A few ordinary browser behaviours can trigger that top-level nav
// without any of our own code asking for it, so we neutralise them here, once,
// at the document level in the capture phase.
//
// Why this exists: a user ⌘/Ctrl-clicked a file-path link in a terminal and the
// entire app reloaded (all panes gone) while the file never opened. On macOS 26
// WKWebView is fragile about exactly these default actions (and Ctrl+click is a
// secondary/context-menu click there). These guards stop the reload class dead;
// the actual path-open still runs via the link's own handler (onOpenPath).
//
// What we block:
//   - OS file drops onto the window — an unhandled drop makes WKWebView navigate
//     to the dropped file:// URL, replacing the app. Classic Tauri gotcha.
//   - Clicks on real <a href> anchors — this UI never uses in-page anchor
//     navigation; any that slipped in must not unload the page.
//   - Form submits — same reasoning; there are no server-backed forms here.
//   - The native context menu — unused by this app, and on macOS 26 it is the
//     prime suspect for the Ctrl+click reload. Suppressing it is safe (copy is
//     ⌘C over the PTY, paste is ⌘V) and removes the trigger.

/// Install the guards. Idempotent in practice (call once at boot). Safe outside
/// Tauri (plain browser) too — it only prevents defaults that this app never needs.
export function installNavGuard(): void {
  // Block OS file drag-and-drop from navigating the webview.
  const stop = (e: Event) => e.preventDefault();
  window.addEventListener("dragover", stop);
  window.addEventListener("drop", stop);

  // Anchors + form submits: cancel any top-level navigation. Capture phase so we
  // win even if something downstream would otherwise let it through.
  window.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (a) e.preventDefault();
    },
    true,
  );
  window.addEventListener("submit", (e) => e.preventDefault(), true);

  // Suppress the native context menu (unused; a macOS 26 reload trigger).
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}
