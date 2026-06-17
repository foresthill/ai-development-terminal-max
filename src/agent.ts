// Domain model: an Agent is one vertical column (one Claude Code worker). Each
// agent owns a Z-axis stack of Layers — a terminal, a browser, an extra
// terminal — only one of which is "front" at a time. This is the depth that a
// flat tmux/zellij layout can't express.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { spawnPty, PtyHandle } from "./pty";

export type LayerKind = "terminal" | "browser";

export interface Layer {
  id: string;
  kind: LayerKind;
  title: string;
  el: HTMLElement; // the layer card root
  term?: Terminal;
  fit?: FitAddon;
  pty?: PtyHandle;
  started: boolean;
  // terminal config captured for lazy spawn
  shell?: string;
  args?: string[];
  cwd?: string | null;
  iframe?: HTMLIFrameElement;
}

export interface Agent {
  id: string;
  title: string;
  cwd: string | null;
  manualTitle: boolean; // true once the user renames; stops dir-derived titles
  layers: Layer[];
  active: number; // index of front layer
  cardEl: HTMLElement;
  headerEl: HTMLElement;
  stackEl: HTMLElement;
  titleEl: HTMLElement;
  pathEl: HTMLInputElement;
  pickEl: HTMLButtonElement;
  dotsEl: HTMLElement;
}

/// Last path segment, used to derive an agent's title from its working dir.
export function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

const TERM_THEME = {
  background: "#0b0e14",
  foreground: "#c8d3f5",
  cursor: "#7aa2f7",
  selectionBackground: "#2d3f76",
};

export function createTerminalLayer(opts: {
  title: string;
  shell: string;
  args?: string[];
  cwd?: string | null;
}): Layer {
  const el = document.createElement("div");
  el.className = "layer layer-terminal";
  const host = document.createElement("div");
  host.className = "term-host";
  el.appendChild(host);

  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", "JetBrains Mono", monospace',
    fontSize: 12,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    theme: TERM_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // WebGL unavailable (rare) — xterm falls back to canvas automatically.
  }

  const layer: Layer = {
    id: uid("term"),
    kind: "terminal",
    title: opts.title,
    el,
    term,
    fit,
    started: false,
    shell: opts.shell,
    args: opts.args,
    cwd: opts.cwd ?? null,
  };

  term.onData((data) => layer.pty?.write(data));
  return layer;
}

export function createBrowserLayer(url: string): Layer {
  const el = document.createElement("div");
  el.className = "layer layer-browser";

  const bar = document.createElement("div");
  bar.className = "url-bar";
  const input = document.createElement("input");
  input.value = url;
  input.spellcheck = false;
  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");

  const go = () => {
    let v = input.value.trim();
    if (v && !/^https?:\/\//.test(v)) v = "http://" + v;
    iframe.src = v;
    input.value = v;
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
    e.stopPropagation(); // don't trigger app-level nav chords while typing a URL
  });

  bar.appendChild(input);
  el.appendChild(bar);
  el.appendChild(iframe);

  return {
    id: uid("web"),
    kind: "browser",
    title: "browser",
    el,
    started: true,
    iframe,
  };
}

/// Lazily spawn the PTY the first time a terminal layer becomes visible/sized.
export async function startLayer(layer: Layer, cols: number, rows: number) {
  if (layer.started || layer.kind !== "terminal" || !layer.term) return;
  layer.started = true;
  layer.pty = await spawnPty({
    id: layer.id,
    shell: layer.shell!,
    args: layer.args ?? [],
    cwd: layer.cwd ?? null,
    cols,
    rows,
    onData: (bytes) => layer.term!.write(bytes),
  });
}

export function fitLayer(layer: Layer) {
  if (layer.kind !== "terminal" || !layer.fit || !layer.term) return;
  try {
    layer.fit.fit();
    if (layer.started && layer.pty) {
      layer.pty.resize(layer.term.cols, layer.term.rows);
    }
  } catch {
    // host not laid out yet; a later refresh will catch it.
  }
}

export function disposeLayer(layer: Layer) {
  if (layer.pty) layer.pty.kill();
  if (layer.term) layer.term.dispose();
  layer.el.remove();
}

/// Inline-edit an agent's title (double-click). Commits on Enter/blur, marks the
/// title as manually set, and calls `onCommit` (typically a re-render).
export function startTitleEdit(agent: Agent, onCommit: () => void) {
  const el = agent.titleEl;
  el.contentEditable = "true";
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const commit = () => {
    el.contentEditable = "false";
    agent.title = (el.textContent ?? "").trim() || agent.title;
    agent.manualTitle = true;
    el.removeEventListener("blur", commit);
    el.removeEventListener("keydown", onKey);
    onCommit();
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      el.blur();
    }
  };
  el.addEventListener("blur", commit);
  el.addEventListener("keydown", onKey);
}

export function createAgent(index: number): Agent {
  const cardEl = document.createElement("div");
  cardEl.className = "agent";

  const headerEl = document.createElement("div");
  headerEl.className = "agent-header";

  const titleRow = document.createElement("div");
  titleRow.className = "agent-title-row";

  const titleEl = document.createElement("div");
  titleEl.className = "agent-title";
  titleEl.textContent = `agent ${index}`;
  titleEl.title = "ダブルクリックで名前変更";

  const dotsEl = document.createElement("div");
  dotsEl.className = "layer-dots";

  titleRow.appendChild(titleEl);
  titleRow.appendChild(dotsEl);

  const pathRow = document.createElement("div");
  pathRow.className = "agent-path-row";
  const pickEl = document.createElement("button");
  pickEl.className = "agent-pick";
  pickEl.textContent = "📁";
  pickEl.title = "フォルダを選択";
  const pathEl = document.createElement("input");
  pathEl.className = "agent-path";
  pathEl.placeholder = "作業ディレクトリ（パス or 📁）";
  pathEl.spellcheck = false;
  pathRow.append(pickEl, pathEl);

  headerEl.appendChild(titleRow);
  headerEl.appendChild(pathRow);

  const stackEl = document.createElement("div");
  stackEl.className = "stack";

  cardEl.appendChild(headerEl);
  cardEl.appendChild(stackEl);

  return {
    id: uid("agent"),
    title: `agent ${index}`,
    cwd: null,
    manualTitle: false,
    layers: [],
    active: 0,
    cardEl,
    headerEl,
    stackEl,
    titleEl,
    pathEl,
    pickEl,
    dotsEl,
  };
}
