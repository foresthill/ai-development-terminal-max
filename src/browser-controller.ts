// CDP browser layer, stage C2 (方式A, embedded): drive the user's real Chrome over CDP and
// show the page INSIDE the app — Chrome runs headless (no separate window), its frames stream
// via Page.startScreencast into a <canvas>, and the canvas forwards mouse/keyboard back over
// Input.*. src-tauri/src/browser.rs launches + detects Chrome; the mechanism was proven in
// spike/browser-cdp (C1: connect/AX/actions; C2: screencast frames + CDP input). See
// docs/2026-11-16-editor-and-browser-cdp.md.
//
// The webview can't use Playwright (Node-only), so this speaks raw CDP over a WebSocket.
// Input-coordinate scaling and the key map are a first pass — expect on-device tuning.
import { invoke } from "@tauri-apps/api/core";
import type { Layer } from "./agent";
import { toast } from "./ui";
import { t } from "./i18n";

// --- Rust bridges -------------------------------------------------------------------
export interface LaunchInfo {
  pid: number;
  port: number;
  ws_url: string;
}
export const browserDetect = (): Promise<string | null> => invoke("browser_detect");
export const browserLaunch = (url: string, headless: boolean): Promise<LaunchInfo> =>
  invoke("browser_launch", { url, headless });
export const browserClose = (pid: number): Promise<void> => invoke("browser_close", { pid });

// --- Minimal CDP client over a WebSocket (commands + events) ------------------------
interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}
type Json = Record<string, unknown>;

export interface AxNode {
  backendNodeId: number;
  role: string;
  name: string;
}

class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((p: Json) => void)[]>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String(ev.data)) as CdpMessage;
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
        else p.resolve((msg.result ?? {}) as Json);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) ?? []) cb((msg.params ?? {}) as Json);
      }
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error("CDP WebSocket failed to open"));
    });
  }

  on(method: string, cb: (p: Json) => void): void {
    const arr = this.listeners.get(method) ?? [];
    arr.push(cb);
    this.listeners.set(method, arr);
  }

  send(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async axTree(): Promise<AxNode[]> {
    const res = await this.send("Accessibility.getFullAXTree");
    const nodes = (res.nodes as Json[] | undefined) ?? [];
    const out: AxNode[] = [];
    for (const n of nodes) {
      if (n.ignored) continue;
      const role = ((n.role as Json | undefined)?.value as string | undefined) ?? "";
      const name = (((n.name as Json | undefined)?.value as string | undefined) ?? "").trim();
      const backend = n.backendDOMNodeId as number | undefined;
      if (backend == null || !role || role === "none" || role === "generic" || role === "InlineTextBox") continue;
      if (!name && !/(button|link|textbox|checkbox|radio|combobox|menuitem|tab|option|searchbox|switch|slider)/i.test(role))
        continue;
      out.push({ backendNodeId: backend, role, name });
    }
    return out;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    for (const p of this.pending.values()) p.reject(new Error("CDP closed"));
    this.pending.clear();
    this.listeners.clear();
  }
}

// Special (non-printable) keys → Chromium virtual key codes for Input.dispatchKeyEvent.
const VKEY: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

function mkBtn(label: string, title?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "cdp-btn";
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("mousedown", (e) => e.stopPropagation());
  return b;
}

/// Build an embedded CDP browser layer (C2): launches the user's Chrome headless for `url`
/// and renders its live screencast into a canvas, forwarding mouse/keyboard over CDP. A small
/// AX button toggles an accessibility-tree overlay (role · name) for inspection.
export function createCdpBrowserLayer(url: string): Layer {
  const el = document.createElement("div");
  el.className = "layer layer-cdp";

  const bar = document.createElement("div");
  bar.className = "cdp-bar";
  const dot = document.createElement("span");
  dot.className = "cdp-dot";
  const urlInput = document.createElement("input");
  urlInput.className = "cdp-url";
  urlInput.value = url;
  const goBtn = mkBtn(t("cdp.go"));
  const axBtn = mkBtn(t("cdp.ax"), t("cdp.axTip"));
  bar.append(dot, urlInput, goBtn, axBtn);

  const canvas = document.createElement("canvas");
  canvas.className = "cdp-canvas";
  canvas.tabIndex = 0;
  const ctx = canvas.getContext("2d");

  const axOverlay = document.createElement("div");
  axOverlay.className = "cdp-ax-overlay";
  axOverlay.style.display = "none";

  const status = document.createElement("div");
  status.className = "cdp-status";
  status.textContent = t("cdp.launching");

  el.append(bar, canvas, axOverlay, status);

  const layer: Layer = {
    id: "cdp-" + Math.random().toString(36).slice(2, 10),
    kind: "browser",
    title: "Chrome (CDP)",
    el,
    started: true,
  };

  let cdp: Cdp | null = null;
  const setStatus = (msg: string, ok = true) => {
    status.textContent = msg;
    dot.classList.toggle("on", ok);
  };

  // --- screencast → canvas ----------------------------------------------------------
  const paint = (b64: string) => {
    const img = new Image();
    img.onload = () => {
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      ctx?.drawImage(img, 0, 0);
    };
    img.src = "data:image/jpeg;base64," + b64;
  };

  // --- input → CDP (coords scaled from the canvas's displayed size to frame pixels) --
  const toPage = (e: MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / (r.width || 1);
    const sy = canvas.height / (r.height || 1);
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  };
  const mouse = (type: string, e: MouseEvent, extra: Json = {}) => {
    if (!cdp) return;
    const { x, y } = toPage(e);
    void cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  };
  canvas.addEventListener("mousedown", (e) => {
    canvas.focus();
    mouse("mousePressed", e);
  });
  canvas.addEventListener("mouseup", (e) => mouse("mouseReleased", e));
  canvas.addEventListener("mousemove", (e) => {
    if (e.buttons & 1) mouse("mouseMoved", e, { button: "left" });
  });
  canvas.addEventListener("wheel", (e) => {
    if (!cdp) return;
    e.preventDefault();
    const { x, y } = toPage(e);
    void cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: -e.deltaX, deltaY: -e.deltaY });
  });
  canvas.addEventListener("keydown", (e) => {
    if (!cdp) return;
    e.preventDefault();
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      void cdp.send("Input.insertText", { text: e.key });
      return;
    }
    const vk = VKEY[e.key];
    if (vk != null) {
      const base = { key: e.key, code: e.code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      void cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      void cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
  });

  // --- AX inspector overlay ---------------------------------------------------------
  const renderAx = (nodes: AxNode[]) => {
    axOverlay.textContent = "";
    for (const n of nodes) {
      const row = document.createElement("div");
      row.className = "cdp-node";
      row.textContent = `${n.role}  ${n.name}`;
      axOverlay.append(row);
    }
  };
  axBtn.addEventListener("click", async () => {
    if (axOverlay.style.display === "none") {
      axOverlay.style.display = "";
      try {
        if (cdp) renderAx(await cdp.axTree());
      } catch {
        /* ignore */
      }
    } else {
      axOverlay.style.display = "none";
    }
  });

  const navigate = () => {
    if (cdp) void cdp.send("Page.navigate", { url: urlInput.value });
  };
  goBtn.addEventListener("click", navigate);
  urlInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") navigate();
  });

  // Launch headless + attach + start the screencast.
  void (async () => {
    const chrome = await browserDetect().catch(() => null);
    if (!chrome) {
      setStatus(t("cdp.noChrome"), false);
      return;
    }
    try {
      const info = await browserLaunch(url, true);
      layer.cdpPid = info.pid;
      cdp = await Cdp.connect(info.ws_url);
      layer.cleanup = () => {
        cdp?.close();
        void browserClose(info.pid);
      };
      await cdp.send("Page.enable");
      await cdp.send("DOM.enable");
      await cdp.send("Runtime.enable");
      cdp.on("Page.screencastFrame", (p) => {
        const data = p.data as string | undefined;
        const sessionId = p.sessionId as number | undefined;
        if (data) paint(data);
        if (cdp && sessionId != null) void cdp.send("Page.screencastFrameAck", { sessionId });
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1600, maxHeight: 1200 });
      setStatus(t("cdp.embedded"));
    } catch (e) {
      setStatus(t("cdp.attachFail", String(e)), false);
      toast(t("cdp.attachFail", String(e)), "error");
    }
  })();

  return layer;
}
