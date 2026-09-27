import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";
import { registerCsiGuards } from "./terminal-guards";

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

  it("leaves other private modes (e.g. 1049 alt-screen) alone", async () => {
    // We must not accidentally swallow the alternate-screen switch — only 1004.
    const t = newTerm();
    registerCsiGuards(t.parser);
    await write(t, `${ESC}[?1049h`);
    expect(t.buffer.active.type).toBe("alternate");
  });
});
