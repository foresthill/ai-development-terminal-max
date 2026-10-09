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
/// Returning `true` from a handler means "handled — do not run xterm's default",
/// so for the swallowed sequences xterm never emits a reply.
export function registerCsiGuards(parser: CsiParserLike): void {
  const only1004 = (params: (number | number[])[]) =>
    params.length === 1 && params[0] === 1004;
  parser.registerCsiHandler({ prefix: "?", final: "h" }, only1004);
  parser.registerCsiHandler({ prefix: "?", final: "l" }, only1004);

  const swallowDecxcpr = (params: (number | number[])[]) =>
    params.length === 1 && params[0] === 6;
  parser.registerCsiHandler({ prefix: "?", final: "n" }, swallowDecxcpr);
}
