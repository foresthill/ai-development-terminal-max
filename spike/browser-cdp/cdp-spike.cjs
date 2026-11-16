// Spike: prove "方式A" for the in-app browser — detect the user's Chrome/Chromium,
// launch it with a remote-debugging port, attach over CDP, read the accessibility
// (AX) tree as role+name+ref, and drive click/type. This is the mechanism the real
// browser-controller.ts + browser.rs will wrap; validated here against the sandbox's
// pre-installed Chromium before any Tauri build.
//
// Run: node spike/browser-cdp/cdp-spike.cjs
//
// On the user's machine the only difference is detectChrome() resolves a real Chrome
// and we launch headed (headless:false) in a new window; the CDP/AX/action code is
// identical.
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdtempSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// --- 1. Detect the user's Chrome/Chromium (the real app's detection logic) ----------
// Returns the first existing candidate for the current OS, or null. The sandbox has no
// system Chrome, so we fall back to Playwright's bundled Chromium to exercise the flow.
function detectChrome() {
  const C = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  };
  for (const p of C[process.platform] || []) if (existsSync(p)) return p;
  return null;
}

const PORT = 9333;
const PAGE =
  "data:text/html," +
  encodeURIComponent(`
  <!doctype html><title>CDP spike</title>
  <h1>Hello</h1>
  <label>Name <input id="n" aria-label="name field"></label>
  <button id="go">Submit</button>
  <p id="out">idle</p>
  <script>
    document.getElementById('go').onclick = () =>
      document.getElementById('out').textContent =
        'clicked; value=' + document.getElementById('n').value;
  </script>`);

async function main() {
  const detected = detectChrome();
  const exe = detected || chromium.executablePath();
  console.log("detectChrome():", detected || "(none — using Playwright Chromium)", "\nlaunching:", exe);

  const userDataDir = mkdtempSync(join(tmpdir(), "cdp-spike-"));
  // Launch the EXTERNAL browser ourselves with a debugging port — exactly what browser.rs
  // will do (headed on a real desktop; headless here since the sandbox has no display).
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-sandbox",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  // Wait for the CDP endpoint, then ATTACH (not launch) — the connectOverCDP path.
  let browser;
  for (let i = 0; i < 40; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!browser) throw new Error("could not attach to CDP endpoint");
  console.log("connectOverCDP: attached ✓");

  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(PAGE);
  console.log("navigated ✓  title:", await page.title());

  // --- AX tree for the AI (role + name) ---------------------------------------------
  // ariaSnapshot() is Playwright's current accessibility view: a compact YAML of
  // role/name lines — exactly the token-light, coordinate-free tree to hand an AI.
  const aria = await page.locator("body").ariaSnapshot();
  console.log("\nAX (ariaSnapshot):");
  for (const line of aria.split("\n").slice(0, 12)) console.log("  " + line);

  // --- AI actions: type into the field, click the button, read the result -----------
  await page.getByLabel("name field").fill("Ada");
  await page.getByRole("button", { name: "Submit" }).click();
  const out = await page.locator("#out").textContent();
  console.log("\naction result (#out):", JSON.stringify(out));

  // --- A screenshot frame (C2 will stream these via Page.startScreencast) ------------
  const shot = await page.screenshot();
  console.log("screenshot bytes:", shot.length, "(C2 streams frames like this to a canvas)");

  await browser.close();
  child.kill();
  const ok = out === "clicked; value=Ada";
  console.log("\n方式A core:", ok ? "VALIDATED ✓" : "FAILED ✗");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("spike failed:", e);
  process.exit(1);
});
