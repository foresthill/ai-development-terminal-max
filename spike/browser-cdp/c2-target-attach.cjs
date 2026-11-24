// Verify the robust C2 attach path: connect to the BROWSER ws endpoint (always present via
// /json/version) and use Target.attachToTarget(flatten) to drive a page — version-robust,
// unlike grabbing a type:"page" entry from /json/list (newer Chrome may report "tab").
// Uses Node's global WebSocket (raw CDP, like the webview does). Network-free (data: URL).
const { spawn } = require("node:child_process");
const { mkdtempSync, readFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const http = require("node:http");

const EXE = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const PAGE = "data:text/html," + encodeURIComponent("<input id=n aria-label=n><p id=o>idle</p><script>n.oninput=()=>o.textContent='typed='+n.value</script>");

const httpGet = (port, path) =>
  new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port, path }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(b));
    }).on("error", rej);
  });

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "c2attach-"));
  const child = spawn(EXE, [
    "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--use-mock-keychain",
    "--no-sandbox", "--headless=new", "about:blank",
  ], { stdio: "ignore" });

  let port;
  for (let i = 0; i < 40; i++) { if (existsSync(join(profile, "DevToolsActivePort"))) { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim(); break; } await new Promise(r=>setTimeout(r,250)); }
  const ver = JSON.parse(await httpGet(port, "/json/version"));
  const browserWs = ver.webSocketDebuggerUrl;
  console.log("browser ws:", !!browserWs);

  const ws = new WebSocket(browserWs);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws fail")); });

  let seq = 0; const pending = new Map(); let sessionId = null; let frames = 0;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method === "Page.screencastFrame") { frames++; send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, m.sessionId); }
  };
  const send = (method, params = {}, sess) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify(sess ? { id, method, params, sessionId: sess } : { id, method, params })); });

  // find or create a page target, attach flat → sessionId
  const { targetInfos } = await send("Target.getTargets");
  let page = targetInfos.find((t) => t.type === "page");
  console.log("existing page target:", !!page, "| types:", [...new Set(targetInfos.map(t=>t.type))].join(","));
  if (!page) { const { targetId } = await send("Target.createTarget", { url: "about:blank" }); page = { targetId }; console.log("created page target"); }
  ({ sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }));
  console.log("attached, sessionId:", !!sessionId);

  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Page.navigate", { url: PAGE }, sessionId);
  await new Promise(r=>setTimeout(r,400));
  await send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 640, maxHeight: 480 }, sessionId);
  // type via CDP
  await send("Runtime.evaluate", { expression: "document.getElementById('n').focus()" }, sessionId);
  await send("Input.insertText", { text: "Hi" }, sessionId);
  await new Promise(r=>setTimeout(r,500));
  const out = await send("Runtime.evaluate", { expression: "document.getElementById('o').textContent", returnByValue: true }, sessionId);
  await send("Page.stopScreencast", {}, sessionId);

  console.log("screencast frames:", frames, "| input result:", JSON.stringify(out.result.value));
  ws.close(); child.kill();
  const ok = frames > 0 && out.result.value === "typed=Hi";
  console.log("\nrobust attach path:", ok ? "VALIDATED ✓" : "FAILED ✗");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("spike failed:", e); process.exit(1); });
