// DOM-free registration of the CSI guard handlers we install on every terminal.
// Extracted from agent.ts so the EXACT same registration can be unit-tested
// against @xterm/headless (identical parser core, no WKWebView) — which is where
// we reproduce the cursor-report loop that makes vim uncontrollable in-app.
// See docs/2026-07-15-vim-debugging-journey.md and terminal-guards.test.ts.

/** Minimal shape of xterm's parser we use — satisfied by both `@xterm/xterm`'s
 *  and `@xterm/headless`'s `Terminal.parser`, so the same guards run in the app
 *  and in the headless test bench. */
export interface CsiParserLike {
  registerCsiHandler(
    id: { prefix?: string; intermediates?: string; final: string },
    callback: (params: (number | number[])[]) => boolean,
  ): unknown;
}

/// Install the CSI handlers every terminal layer needs. Two guards:
///
///  1. Focus reporting (DECSET/DECRST 1004) — swallowed. We never use it and a
///     focus thrash would flood the app. Other `?`-prefixed modes fall through to
///     xterm's default handling untouched.
///
///  2. The cursor-position report LOOP — the reason vim is uncontrollable in-app
///     but fine in Terminal.app. The live Alt+D trace (and the headless repro)
///     show a continuous loop at an idle prompt, on every pane:
///        child → `\e[?6n`  (DECXCPR cursor-position request)
///        xterm → `\e[?<row>;<col>R`  (auto-reply), which agent.ts writes back to
///        the PTY → the child requests again → forever. That flood buries real
///        keystrokes. We swallow ONLY the private `\e[?6n`; the plain `\e[6n`
///        (no `?`, used by vim's size probe) stays on xterm's default handler.
///
///  3. The ALTERNATE SCREEN (DECSET/DECRST 47 / 1047 / 1049) — swallowed as a
///     WORKAROUND for a macOS 26 (Tahoe) WKWebView bug: on an Apple-Silicon
///     RELEASE build the compositor stops presenting new frames for the alt-screen
///     while the DOM keeps updating, so vim/less/htop draw into the DOM (and even
///     save to disk) but the screen stays frozen on the first frame. The NORMAL
///     (scrolling) buffer repaints fine. Upstream: tauri-apps/wry#1848 (no fix).
///     By swallowing the alt-screen switch, full-screen TUIs render on the normal
///     buffer (like vim's `set t_ti= t_te=`), which paints — so they become usable.
///     Trade-off: their output stays in the scrollback instead of being restored
///     on exit. 1048 (cursor save/restore) is left to xterm. See the vim journey doc.
///
/// Returning `true` from a handler means "handled — do not run xterm's default",
/// so for the swallowed sequences xterm never emits a reply / never switches buffer.
/// Whether to swallow the alternate-screen switch (the macOS 26 workaround, guard #3).
/// OFF by default so every platform keeps normal full-screen TUIs; main.ts turns it on
/// only when the Rust `alt_screen_broken` command says this host is affected (macOS 26
/// release). Must be set BEFORE terminals are created.
let _disableAltScreen = false;
export function setDisableAltScreen(on: boolean): void {
  _disableAltScreen = on;
}

export function registerCsiGuards(parser: CsiParserLike): void {
  // 1004 focus-reporting is always swallowed. 47/1047/1049 alt-screen is swallowed
  // ONLY when _disableAltScreen is on (macOS 26 release). Everything else (cursor
  // visibility 25, bracketed paste 2004, mouse 1000/1002/1006, …) must fall through.
  const ALT = new Set([47, 1047, 1049]);
  const swallowModes = (params: (number | number[])[]) => {
    if (params.length !== 1 || typeof params[0] !== "number") return false;
    const m = params[0];
    if (m === 1004) return true;
    if (_disableAltScreen && ALT.has(m)) return true;
    return false;
  };
  parser.registerCsiHandler({ prefix: "?", final: "h" }, swallowModes);
  parser.registerCsiHandler({ prefix: "?", final: "l" }, swallowModes);

  const swallowDecxcpr = (params: (number | number[])[]) =>
    params.length === 1 && params[0] === 6;
  parser.registerCsiHandler({ prefix: "?", final: "n" }, swallowDecxcpr);
}
