import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";
import { registerCsiGuards, setDisableAltScreen } from "./terminal-guards";

// Headless test bench for the cursor-report loop that makes vim uncontrollable
// in-app. @xterm/headless shares xterm's parser/DSR core but needs no DOM or
// WKWebView, so the loop's SOURCE — xterm auto-replying to a cursor-position
// request — reproduces here and the fix is verifiable without a rebuild.
//
// This covers the INPUT/control side only. The alternate-screen PAINT bug is
// genuinely WKWebView-specific and cannot be exercised headlessly.

const ESC = "\x1b";
// Match how the app constructs terminals (agent.ts): `parser` is proposed API.
const newTerm = () => new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
const write = (t: Terminal, d: string) =>
  new Promise<void>((resolve) => t.write(d, () => resolve()));

/** Collect everything the terminal would send back to the PTY (its onData). */
function captureReplies(t: Terminal): { text: () => string } {
  let out = "";
  t.onData((d) => (out += d));
  return { text: () => out };
}

describe("cursor-report loop guard", () => {
  it("REPRODUCES the loop source: unguarded, \\e[?6n triggers an auto-reply", async () => {
    // This is the byte the live Alt+D trace showed the child emitting; xterm's
    // auto-reply is what agent.ts wrote back to the PTY, feeding the loop.
    const t = newTerm();
    const replies = captureReplies(t);
    await write(t, `${ESC}[?6n`);
    expect(replies.text()).toMatch(/\x1b\[\?\d+;\d+R/); // e.g. \e[?1;1R
  });

  it("FIX: with the guard, \\e[?6n is swallowed — no reply, loop broken", async () => {
    const t = newTerm();
    registerCsiGuards(t.parser);
    const replies = captureReplies(t);
    await write(t, `${ESC}[?6n`);
    expect(replies.text()).toBe("");
  });

  it("stays surgical: the plain \\e[6n (used by vim's size probe) still replies", async () => {
    const t = newTerm();
    registerCsiGuards(t.parser);
    const replies = captureReplies(t);
    await write(t, `${ESC}[6n`);
    expect(replies.text()).toMatch(/\x1b\[\d+;\d+R/); // plain CPR, no `?`
  });

  it("still swallows focus reporting (DECSET/DECRST 1004)", async () => {
    const t = newTerm();
    registerCsiGuards(t.parser);
    // A program enabling focus reporting then a focus event must not echo back.
    const replies = captureReplies(t);
    await write(t, `${ESC}[?1004h`);
    expect(replies.text()).toBe("");
  });

  it("keeps the alt-screen by default (unaffected platforms are not degraded)", async () => {
    setDisableAltScreen(false); // default
    const t = newTerm();
    registerCsiGuards(t.parser);
    await write(t, `${ESC}[?1049h`);
    expect(t.buffer.active.type).toBe("alternate");
  });

  it("swallows the alt-screen switch (47/1047/1049) when the macOS 26 workaround is on", async () => {
    // WORKAROUND for wry#1848: on macOS 26 the alt-screen never repaints in a release
    // WKWebView, so (only there) we keep full-screen TUIs on the normal (scrolling)
    // buffer, which does paint. The buffer must stay "normal" after ?1049h.
    try {
      setDisableAltScreen(true);
      for (const mode of [47, 1047, 1049]) {
        const t = newTerm();
        registerCsiGuards(t.parser);
        await write(t, `${ESC}[?${mode}h`);
        expect(t.buffer.active.type).toBe("normal");
      }
    } finally {
      setDisableAltScreen(false); // don't leak the flag to other tests
    }
  });

  it("stays surgical: a non-swallowed private mode (2004 bracketed paste) still applies", async () => {
    // Guard against over-swallowing: only our set is intercepted, others fall through.
    setDisableAltScreen(true);
    try {
      const t = newTerm();
      registerCsiGuards(t.parser);
      await write(t, `${ESC}[?2004h`);
      expect(t.modes.bracketedPasteMode).toBe(true);
    } finally {
      setDisableAltScreen(false);
    }
  });
});
