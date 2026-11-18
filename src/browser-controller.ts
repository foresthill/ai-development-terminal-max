// CDP browser layer, stage C1 (方式A): the frontend half of the "drive the user's real
// Chrome over CDP" feature. src-tauri/src/browser.rs detects + launches an external Chrome
// (headed, separate OS window, throwaway profile) and returns the page's CDP WebSocket URL;
// here we attach to it and expose navigate + accessibility tree + click/type, shown in an
// in-app control/inspector panel. The page itself renders in its own window (C1); C2 will
// embed it via Page.startScreencast → <canvas>.
//
// The real app can't use Playwright (Node-only), so this speaks raw CDP over a WebSocket.
// The mechanism was proven first in spike/browser-cdp. See docs/2026-11-16-editor-and-browser-cdp.md.
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
export const browserLaunch = (url: string): Promise<LaunchInfo> => invoke("browser_launch", { url });
export const browserClose = (pid: number): Promise<void> => invoke("browser_close", { pid });

// --- Minimal CDP client over a WebSocket --------------------------------------------
interface CdpResponse {
  id?: number;
  method?: string;
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

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      let msg: CdpResponse;
      try {
        msg = JSON.parse(String(ev.data)) as CdpResponse;
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
        else p.resolve((msg.result ?? {}) as Json);
      }
      // events (no id) are ignored in C1
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error("CDP WebSocket failed to open"));
    });
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

  async enableDomains(): Promise<void> {
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Runtime.enable");
    await this.send("Accessibility.enable");
  }

  navigate(url: string): Promise<Json> {
    return this.send("Page.navigate", { url });
  }

  /// Full accessibility tree flattened to the compact {role, name, backendNodeId} rows an
  /// AI (or a human) acts on — coordinate-free and token-light.
  async axTree(): Promise<AxNode[]> {
    const res = await this.send("Accessibility.getFullAXTree");
    const nodes = (res.nodes as Json[] | undefined) ?? [];
    const out: AxNode[] = [];
    for (const n of nodes) {
      if (n.ignored) continue;
      const role = ((n.role as Json | undefined)?.value as string | undefined) ?? "";
      const name = (((n.name as Json | undefined)?.value as string | undefined) ?? "").trim();
      const backend = n.backendDOMNodeId as number | undefined;
      if (backend == null) continue;
      if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;
      if (!name && !/^(text|image|img)$/i.test(role)) {
        // keep interactive roles even when unnamed; drop nameless decorative nodes
        if (!/(button|link|textbox|checkbox|radio|combobox|menuitem|tab|option|searchbox|switch|slider)/i.test(role))
          continue;
      }
      out.push({ backendNodeId: backend, role, name });
    }
    return out;
  }

  private async centerOf(backendNodeId: number): Promise<{ x: number; y: number }> {
    const res = await this.send("DOM.getBoxModel", { backendNodeId });
    const model = res.model as Json | undefined;
    const q = (model?.content as number[] | undefined) ?? [];
    if (q.length < 8) throw new Error("element has no box");
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  }

  async clickNode(backendNodeId: number): Promise<void> {
    const { x, y } = await this.centerOf(backendNodeId);
    const base = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  async typeInNode(backendNodeId: number, text: string): Promise<void> {
    await this.send("DOM.focus", { backendNodeId });
    await this.send("Input.insertText", { text });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    for (const p of this.pending.values()) p.reject(new Error("CDP closed"));
    this.pending.clear();
  }
}

// --- The in-app control/inspector panel (the browser layer body) --------------------
function mkBtn(label: string, title?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "cdp-btn";
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("mousedown", (e) => e.stopPropagation());
  return b;
}

/// Build a CDP browser layer: launches the user's Chrome for `url` in its own window and
/// shows a control panel (URL bar · AX inspector · click/type) wired to it over CDP.
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
  bar.append(dot, urlInput, goBtn);

  const tools = document.createElement("div");
  tools.className = "cdp-tools";
  const axBtn = mkBtn(t("cdp.ax"), t("cdp.axTip"));
  const clickBtn = mkBtn(t("cdp.click"));
  const typeInput = document.createElement("input");
  typeInput.className = "cdp-type";
  typeInput.placeholder = t("cdp.typePlaceholder");
  const typeBtn = mkBtn(t("cdp.typeBtn"));
  tools.append(axBtn, clickBtn, typeInput, typeBtn);

  const list = document.createElement("div");
  list.className = "cdp-list";
  const status = document.createElement("div");
  status.className = "cdp-status";
  status.textContent = t("cdp.launching");

  el.append(bar, tools, list, status);

  const layer: Layer = {
    id: "cdp-" + Math.random().toString(36).slice(2, 10),
    kind: "browser",
    title: "Chrome (CDP)",
    el,
    started: true,
  };

  let cdp: Cdp | null = null;
  let selected: number | null = null;

  const setStatus = (msg: string, ok = true) => {
    status.textContent = msg;
    dot.classList.toggle("on", ok);
  };

  const renderAx = (nodes: AxNode[]) => {
    list.textContent = "";
    for (const n of nodes) {
      const row = document.createElement("div");
      row.className = "cdp-node";
      row.textContent = `${n.role}  ${n.name}`;
      row.title = `backendNodeId ${n.backendNodeId}`;
      row.addEventListener("mousedown", (e) => e.stopPropagation());
      row.addEventListener("click", () => {
        selected = n.backendNodeId;
        for (const c of Array.from(list.children)) c.classList.remove("sel");
        row.classList.add("sel");
      });
      list.append(row);
    }
    setStatus(t("cdp.axCount", String(nodes.length)));
  };

  const refreshAx = async () => {
    if (!cdp) return;
    try {
      renderAx(await cdp.axTree());
    } catch (e) {
      toast(t("cdp.axFail", String(e)), "error");
    }
  };

  goBtn.addEventListener("click", () => void cdp?.navigate(urlInput.value));
  axBtn.addEventListener("click", () => void refreshAx());
  clickBtn.addEventListener("click", async () => {
    if (!cdp || selected == null) return;
    try {
      await cdp.clickNode(selected);
      setStatus(t("cdp.clicked"));
    } catch (e) {
      toast(t("cdp.actionFail", String(e)), "error");
    }
  });
  typeBtn.addEventListener("click", async () => {
    if (!cdp || selected == null) return;
    try {
      await cdp.typeInNode(selected, typeInput.value);
      setStatus(t("cdp.typed"));
    } catch (e) {
      toast(t("cdp.actionFail", String(e)), "error");
    }
  });

  // Kick off the launch + attach. Builds synchronously above so the layer can render now.
  void (async () => {
    const chrome = await browserDetect().catch(() => null);
    if (!chrome) {
      setStatus(t("cdp.noChrome"), false);
      return;
    }
    try {
      const info = await browserLaunch(url);
      layer.cdpPid = info.pid;
      cdp = await Cdp.connect(info.ws_url);
      await cdp.enableDomains();
      layer.cleanup = () => {
        cdp?.close();
        void browserClose(info.pid);
      };
      setStatus(t("cdp.attached"));
      await refreshAx();
    } catch (e) {
      setStatus(t("cdp.attachFail", String(e)), false);
      toast(t("cdp.attachFail", String(e)), "error");
    }
  })();

  return layer;
}
