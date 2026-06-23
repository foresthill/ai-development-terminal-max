// Domain model: an Agent is one vertical column (one Claude Code worker). Each
// agent owns a Z-axis stack of Layers — a terminal, a browser, an extra
// terminal — only one of which is "front" at a time. This is the depth that a
// flat tmux/zellij layout can't express.
import { Terminal, ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { spawnPty, PtyHandle } from "./pty";
import { t } from "./i18n";

export type LayerKind = "terminal" | "browser" | "subagent";

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
  autoRun?: string; // typed into the interactive shell once spawned (e.g. "claude")
  lastOutput?: number; // performance.now() of the last PTY output (for idle status)
  iframe?: HTMLIFrameElement;
  subId?: string; // subagent correlation id (agent_id from the hook payload)
}

export interface Agent {
  id: string;
  title: string;
  cwd: string | null;
  branch: string; // git branch of cwd (worktree/repo), shown as a badge
  cpu: number; // last sampled CPU% of the agent's process subtree
  agentCmd: string; // the CLI agent this window runs (e.g. "claude", "aider")
  running: boolean; // true once the agent command was launched here (for resume)
  manualTitle: boolean; // true once the user renames; stops dir-derived titles
  layers: Layer[];
  active: number; // index of front layer
  cardEl: HTMLElement;
  headerEl: HTMLElement;
  stackEl: HTMLElement;
  titleEl: HTMLElement;
  branchEl: HTMLElement;
  cpuEl: HTMLElement;
  agentSel: HTMLSelectElement;
  runEl: HTMLButtonElement;
  closeEl: HTMLButtonElement;
  pathEl: HTMLInputElement;
  pickEl: HTMLButtonElement;
  tabsEl: HTMLElement;
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
  autoRun?: string;
  // Invoked when a URL in the terminal is ⌘/Ctrl-clicked. The host decides where
  // to open it (in-app browser layer by default).
  onOpenUrl?: (url: string) => void;
  // Invoked when a file path in the terminal is ⌘/Ctrl-clicked. `raw` is the
  // matched token (may be relative or carry a :line suffix); `cwd` is the
  // terminal's working dir so the host can resolve relative paths.
  onOpenPath?: (raw: string, cwd: string | null) => void;
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

  // Clickable URLs. Plain click does nothing (so it never steals a text
  // selection / cursor placement) — only ⌘-click (or Ctrl-click) opens, matching
  // the macOS terminal convention. The host routes the URL (in-app browser).
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) opts.onOpenUrl?.(uri);
    }),
  );

  // Native copy/paste over the PTY: ⌘C copies the current selection to the
  // clipboard (falling through to xterm only when there's nothing selected, so
  // Ctrl-C's SIGINT path is untouched); ⌘V pastes. Returning false stops xterm
  // from also forwarding the keystroke to the shell.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.metaKey) return true;
    if (e.key === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (e.key === "v") {
      void navigator.clipboard.readText().then((text) => {
        if (text) layer.pty?.write(text);
      });
      return false;
    }
    return true;
  });

  // Clickable file paths (web-links only handles http/https). Matches tokens
  // with at least one slash and a file extension — `docs/x/foo.md`, `./src/a.ts`,
  // `/abs/p.rs`, `~/n.md`, optionally with a `:line[:col]` suffix. ⌘/Ctrl-click
  // resolves it against the terminal's cwd and the host opens it (OS default app).
  const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?[\w.\-@+]+(?:\/[\w.\-@+]+)+\.\w{1,8}(?::\d+(?:[:.]\d+)?)?/g;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links: ILink[] = [];
      PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(text)) !== null) {
        const start = m.index;
        const prev = text[start - 1];
        if (prev === "/" || prev === ":") continue; // skip URL tails (host/p.md)
        const raw = m[0];
        links.push({
          text: raw,
          range: { start: { x: start + 1, y }, end: { x: start + raw.length, y } },
          activate: (e: MouseEvent) => {
            if (e.metaKey || e.ctrlKey) opts.onOpenPath?.(raw, layer.cwd ?? null);
          },
        });
      }
      callback(links);
    },
  });

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
    autoRun: opts.autoRun,
  };

  term.onData((data) => layer.pty?.write(data));
  return layer;
}

export function createBrowserLayer(url: string): Layer {
  const el = document.createElement("div");
  el.className = "layer layer-browser";

  const bar = document.createElement("div");
  bar.className = "url-bar";

  const mkBtn = (glyph: string, title: string) => {
    const b = document.createElement("button");
    b.className = "url-btn";
    b.textContent = glyph;
    b.title = title;
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    return b;
  };
  const back = mkBtn("‹", "back");
  const fwd = mkBtn("›", "forward");
  const reload = mkBtn("⟳", "reload");

  const titleInput = document.createElement("input");
  titleInput.className = "browser-title";
  titleInput.placeholder = "title";
  titleInput.spellcheck = false;

  const input = document.createElement("input");
  input.className = "browser-url";
  input.value = url;
  input.spellcheck = false;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");

  // Parent-side history of bar/`go` navigations. (In-page link clicks on
  // cross-origin pages can't be observed, so they aren't tracked here.)
  const hist: string[] = [];
  let hi = -1;
  const updateNav = () => {
    back.disabled = hi <= 0;
    fwd.disabled = hi >= hist.length - 1;
  };
  const show = (v: string) => {
    iframe.src = v;
    input.value = v;
    updateNav();
  };
  const go = (raw: string, push: boolean) => {
    let v = raw.trim();
    if (!v) return;
    if (!/^https?:\/\//.test(v)) v = "http://" + v;
    if (push) {
      hist.splice(hi + 1);
      hist.push(v);
      hi = hist.length - 1;
    }
    show(v);
  };

  back.addEventListener("click", () => {
    if (hi > 0) {
      hi--;
      show(hist[hi]);
    }
  });
  fwd.addEventListener("click", () => {
    if (hi < hist.length - 1) {
      hi++;
      show(hist[hi]);
    }
  });
  reload.addEventListener("click", () => {
    iframe.src = iframe.src; // reassign reloads even cross-origin
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      go(input.value, true);
    }
  });

  bar.append(back, fwd, reload, titleInput, input);
  el.appendChild(bar);
  el.appendChild(iframe);

  const layer: Layer = {
    id: uid("web"),
    kind: "browser",
    title: "browser",
    el,
    started: true,
    iframe,
  };

  // Editable tab label. (Updates layer.title; the tab re-renders on next render.)
  titleInput.addEventListener("keydown", (e) => e.stopPropagation());
  titleInput.addEventListener("input", () => {
    layer.title = titleInput.value.trim() || "browser";
  });

  go(url, true); // initial navigation (seeds history)
  return layer;
}

/// Ephemeral card for a running Claude Code subagent (popped on SubagentStart,
/// removed on SubagentStop). Holds no terminal — its live output isn't available
/// to the host; it shows the subagent type + a running indicator.
export function createSubagentLayer(agentType: string, subId: string): Layer {
  const el = document.createElement("div");
  el.className = "layer layer-subagent";
  const inner = document.createElement("div");
  inner.className = "subagent-card";
  const icon = document.createElement("div");
  icon.className = "subagent-icon";
  icon.textContent = "🤖";
  const name = document.createElement("div");
  name.className = "subagent-name";
  name.textContent = agentType;
  const status = document.createElement("div");
  status.className = "subagent-status";
  status.textContent = t("subagent.running");
  inner.append(icon, name, status);
  el.appendChild(inner);
  return { id: uid("sub"), kind: "subagent", title: agentType, el, started: true, subId };
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
    onData: (bytes) => {
      layer.lastOutput = performance.now();
      layer.term!.write(bytes);
    },
  });
  // Type the agent command into the freshly-started interactive shell so it runs
  // with the user's real PATH (.zshrc is sourced — fixes "command not found").
  if (layer.autoRun) {
    const cmd = layer.autoRun;
    setTimeout(() => layer.pty?.write(cmd + "\r"), 350);
  }
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
  titleEl.title = t("tip.title");

  const branchEl = document.createElement("span");
  branchEl.className = "agent-branch";

  const cpuEl = document.createElement("span");
  cpuEl.className = "agent-cpu";

  const agentSel = document.createElement("select");
  agentSel.className = "agent-sel";
  agentSel.title = t("tip.agentSel");

  const runEl = document.createElement("button");
  runEl.className = "agent-run";
  runEl.textContent = "▶";
  runEl.title = t("tip.runAgent");

  const closeEl = document.createElement("button");
  closeEl.className = "agent-close";
  closeEl.textContent = "×";
  closeEl.title = t("tip.closeAgent");

  // Title row: keep it for the (readable) title + controls only.
  titleRow.appendChild(titleEl);
  titleRow.appendChild(agentSel);
  titleRow.appendChild(runEl);
  titleRow.appendChild(closeEl);

  const pathRow = document.createElement("div");
  pathRow.className = "agent-path-row";
  const pickEl = document.createElement("button");
  pickEl.className = "agent-pick";
  pickEl.textContent = t("agent.pick");
  pickEl.title = t("tip.pick");
  const pathEl = document.createElement("input");
  pathEl.className = "agent-path";
  pathEl.placeholder = t("agent.pathPlaceholder");
  pathEl.spellcheck = false;
  // Path row carries the cwd plus the branch + CPU/RAM status badges.
  pathRow.append(pickEl, pathEl, branchEl, cpuEl);

  // Z-axis layer tabs, sitting directly above the terminal.
  const tabsEl = document.createElement("div");
  tabsEl.className = "layer-tabs";

  headerEl.appendChild(titleRow);
  headerEl.appendChild(pathRow);
  headerEl.appendChild(tabsEl);

  const stackEl = document.createElement("div");
  stackEl.className = "stack";

  cardEl.appendChild(headerEl);
  cardEl.appendChild(stackEl);

  return {
    id: uid("agent"),
    title: `agent ${index}`,
    cwd: null,
    branch: "",
    cpu: 0,
    agentCmd: "claude",
    running: false,
    manualTitle: false,
    layers: [],
    active: 0,
    cardEl,
    headerEl,
    stackEl,
    titleEl,
    branchEl,
    cpuEl,
    agentSel,
    runEl,
    closeEl,
    pathEl,
    pickEl,
    tabsEl,
  };
}
