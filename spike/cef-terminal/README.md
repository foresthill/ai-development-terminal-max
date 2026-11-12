# CEF Terminal Spike

**Goal:** prove — on your macOS 26 machine — that a terminal rendered with **xterm.js
inside CEF (Chromium)** repaints a full-screen TUI (`vim`/`htop`/`less`), where the
system WKWebView (wry) freezes it (wry#1848). If this works, it's the green light to
migrate the real app to the Tauri 3 CEF runtime.

This is a **throwaway, experimental** mini-app: no plugins, static HTML + xterm from a
CDN, and a trimmed copy of the app's PTY bridge. It is **unverified** (built blind on a
Linux cloud with no macOS/CEF), so expect a few build-error round-trips — paste any
error back and I'll fix it.

## Prerequisites (macOS)
```bash
brew install cmake ninja          # CEF compiles its C++ wrapper with these
cargo install tauri-cli --version "^3.0.0-alpha" --locked
```
The **first build downloads ~1 GB** of CEF into `~/Library/Caches/tauri-cef` (shared
across projects) — it's slow once, fast after.

## Run
```bash
cd spike/cef-terminal
cargo tauri dev        # or: cargo tauri build
```
A window titled **CEF Terminal Spike** opens with a shell prompt.

## What to check
1. **Does it build at all?** (CEF download + compile + Tauri 3 alpha.) If not, paste the error.
2. Terminal shows your shell prompt and you can type.
3. **Type `vim`** (or `htop`, or `less somebigfile`). The key question:
   - ✅ **renders and responds** → Chromium/CEF fixes it; we migrate the real app.
   - ❌ **black / frozen on the first frame** → CEF didn't help (unexpected — VS Code proves xterm+Chromium works, so this would point at our setup); we debug.

## Likely iteration points (if the build errors)
- **Runtime selection**: `lib.rs` uses `tauri::Builder::default().runtime(tauri_runtime_cef::Cef::default())`. If the API differs in the alpha you have, the error will say so.
- **Also needs wry?** If it complains about a missing default runtime, add
  `tauri-runtime-wry = "3.0.0-alpha.0"` to `src-tauri/Cargo.toml` `[dependencies]`.
- **Macro/API drift** in Tauri 3 alpha (`generate_handler!`, `Channel`, `Emitter`, `generate_context!`) — report the exact compiler error.
- **CLI version**: the installed `tauri-cli` must be a 3.0 alpha; a 2.x CLI won't understand the runtime crate.
- **tauri.conf.json**: uses the `config/2` schema URL for editor hints only; if the v3 CLI rejects a field, I'll adjust.

## Notes
- Frontend is a single static `dist/index.html` (xterm 5.3 + fit addon from cdnjs),
  talking to Rust via `window.__TAURI__` (`withGlobalTauri: true`). No node/vite.
- PTY bridge (`src-tauri/src/pty.rs`) is a trimmed copy of the app's, incl. the macOS
  `kill(pid,0)` liveness check that fixed the vim-SIGHUP issue.
- Not signed/notarized; Gatekeeper will warn on the built `.app` (right-click → Open).
