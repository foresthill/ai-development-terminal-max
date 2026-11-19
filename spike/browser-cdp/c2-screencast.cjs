// Spike for browser C2 (embed the page in-app): prove the two mechanisms C1 doesn't have —
//   1. Page.startScreencast delivers a stream of frames (the bytes we'll paint to a <canvas>)
//   2. Input.* can drive the page by coordinates/keys (what the canvas forwards back)
// Validated against the sandbox Chromium before wiring any Tauri UI, like the C1 spike.
//
// Run: node spike/browser-cdp/c2-screencast.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PORT = 9344;
const PAGE =
  "data:text/html," +
  encodeURIComponent(`
  <!doctype html><title>C2</title>
  <input id="n" aria-label="name" style="font-size:24px">
  <p id="out">idle</p>
  <script>
    const n=document.getElementById('n'), out=document.getElementById('out');
    n.addEventListener('input',()=>out.textContent='typed='+n.value);
  </script>`);

async function main() {
  const exe = chromium.executablePath();
  const userDataDir = mkdtempSync(join(tmpdir(), "c2-spike-"));
  const child = spawn(
    exe,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, "--headless=new", "--no-sandbox", "about:blank"],
    { stdio: "ignore" },
  );

  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!browser) throw new Error("no CDP");
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = ctx.pages()[0] || (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page);

  // --- 1. screencast: count frames, ack each (the real app paints f.data to a canvas) ---
  let frames = 0;
  let firstBytes = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    frames++;
    if (!firstBytes) firstBytes = Buffer.from(f.data, "base64").length;
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
    } catch {
      /* page gone */
    }
  });
  await cdp.send("Page.enable");
  await page.goto(PAGE);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 640, maxHeight: 480 });

  // --- 2. input over CDP: focus the field, type by key events, read the result back ------
  await page.locator("#n").focus();
  for (const ch of "Hi") {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp" });
  }
  await new Promise((r) => setTimeout(r, 600)); // let a few frames stream
  await cdp.send("Page.stopScreencast");

  const out = await page.locator("#out").textContent();
  console.log("screencast frames received:", frames, "| first frame bytes:", firstBytes);
  console.log("CDP keyboard input → #out:", JSON.stringify(out));

  await browser.close();
  child.kill();
  const ok = frames > 0 && out === "typed=Hi";
  console.log("\nC2 core (screencast + input):", ok ? "VALIDATED ✓" : "FAILED ✗");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error("spike failed:", e);
  process.exit(1);
});
