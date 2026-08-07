// Domain model: an Agent is one vertical column (one Claude Code worker). Each
// agent owns a Z-axis stack of Layers — a terminal, a browser, an extra
// terminal — only one of which is "front" at a time. This is the depth that a
// flat tmux/zellij layout can't express.
import { Terminal, ILink, IBufferLine } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
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
  priority: number; // 0 none · 1 low · 2 mid · 3 high — drives size/color emphasis
  layers: Layer[];
  active: number; // index of front layer
  cardEl: HTMLElement;
  headerEl: HTMLElement;
  stackEl: HTMLElement;
  titleEl: HTMLElement;
  prioEl: HTMLButtonElement; // ● priority flag: click cycles none→low→mid→high
  branchEl: HTMLElement;
  cpuEl: HTMLElement;
  agentSel: HTMLButtonElement; // ▾ caret: opens the CLI chooser (hidden when 1 preset)
  runEl: HTMLButtonElement;
  closeEl: HTMLButtonElement;
  pathEl: HTMLInputElement;
  pickEl: HTMLButtonElement;
  openDirEl: HTMLButtonElement;
  tabsEl: HTMLElement;
}

/// Last path segment, used to derive an agent's title from its working dir.
export function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

/// Map a JS string index (into IBufferLine.translateToString) to a 0-based cell
/// column. Wide (CJK) chars take 2 cells but 1 string char, so a naive index ==
/// column assumption puts links on the wrong columns when full-width text (e.g.
/// "ファイル: ") precedes the link on the same line.
function colForStrIdx(line: IBufferLine, strIdx: number): number {
  let acc = 0;
  for (let col = 0; col < line.length; col++) {
    const cell = line.getCell(col);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // trailing half of a wide char
    if (acc >= strIdx) return col;
    acc += cell.getChars().length || 1;
  }
  return line.length;
}

const TERM_THEME = {
  background: "#0b0e14",
  foreground: "#c8d3f5",
  cursor: "#7aa2f7",
  selectionBackground: "#2d3f76",
};

// TEMP vi-input tracer — logs where a keystroke is lost (window → xterm → data →
// pty) plus what's focused, in a corner overlay. Remove after the bug is found.
const _dbg: string[] = [];
let _dbgEl: HTMLElement | null = null;
let _dbgOn = false; // OFF by default — toggle with Alt+D (out of the way while working)
export function dbgOn(): boolean {
  return _dbgOn;
}
export function setDbg(on: boolean): void {
  _dbgOn = on;
  if (_dbgEl) _dbgEl.style.display = on ? "" : "none";
}
export function toggleDbg(): boolean {
  setDbg(!_dbgOn);
  return _dbgOn;
}
export function dbgLog(msg: string) {
  if (!_dbgOn) return; // gated: no overlay, no localStorage, no per-byte cost when off
  _dbg.push(msg);
  while (_dbg.length > 40) _dbg.shift();
  if (!_dbgEl) {
    _dbgEl = document.createElement("div");
    _dbgEl.className = "input-dbg";
    document.body.appendChild(_dbgEl);
  }
  _dbgEl.textContent = _dbg.slice(-14).join("\n");
  // Also persist so it can be read off disk (localStorage → sqlite) without a
  // screenshot. TEMP.
  try {
    localStorage.setItem("aidt-vidbg", _dbg.join("\n"));
  } catch {
    /* ignore */
  }
}

export function createTerminalLayer(opts: {
  title: string;
  shell: string;
  args?: string[];
  cwd?: string | null;
  autoRun?: string;
  // Invoked when a URL in the terminal is ⌘/Ctrl-clicked. The host decides where
  // to open it (in-app browser layer by default).
  // `modifierHeld` is true when ⌘/Ctrl was down — the host opens the non-default
  // target (in-app browser vs external) for that case.
  onOpenUrl?: (url: string, modifierHeld: boolean) => void;
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
    // Apps that capture the mouse (claude's TUI enables tracking) otherwise eat
    // click/drag, so text can't be selected. On macOS xterm's force-selection
    // modifier is Option (Shift isn't honored here), so let ⌥-drag / ⌥-click
    // select even while an app is tracking the mouse.
    macOptionClickForcesSelection: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  // Swallow focus reporting (DECSET/DECRST 1004). Precautionary: a focus thrash
  // here would flood the app with focus in/out events, and we never use the
  // reports. NOTE: this was first added on the theory that it caused the "vim
  // input jams" bug — it did not; the real cause was the PTY reader treating a
  // transient read error as exit and SIGHUP-ing the shell (fixed in pty.rs).
  // Unverified whether it's still needed now; kept as cheap insurance.
  // Other ?-prefixed modes fall through to xterm's default handling untouched.
  const only1004 = (params: (number | number[])[]) => params.length === 1 && params[0] === 1004;
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, only1004);
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, only1004);
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // WebGL unavailable (rare) — xterm falls back to its built-in DOM renderer.
    // (The canvas addon is deprecated and gone in @xterm/xterm v6, so DOM is the
    // only fallback: https://github.com/xtermjs/xterm.js/issues/3271)
  }

  // Clickable URLs. Plain click opens in the default target (Settings: in-app
  // browser by default); ⌘/Ctrl-click opens the other target (external browser).
  // The host decides based on the modifier flag.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      opts.onOpenUrl?.(uri, event.metaKey || event.ctrlKey);
    }),
  );

  // Native copy/paste over the PTY: ⌘C copies the current selection to the
  // clipboard (falling through to xterm only when there's nothing selected, so
  // Ctrl-C's SIGINT path is untouched); ⌘V pastes. Uses Tauri's clipboard plugin
  // — WKWebView's navigator.clipboard is unreliable, leaving the system
  // pasteboard untouched. Returning false stops xterm from also forwarding the
  // keystroke to the shell.
  // Returning false from attachCustomKeyEventHandler stops xterm from sending the
  // key, but it does NOT prevent the browser default — so the keystroke still
  // reaches xterm's hidden textarea and gets re-sent, corrupting our injected
  // sequence. We must preventDefault() ourselves whenever we handle a key here.
  const handled = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    return false;
  };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // TEMP: dump xterm's internal state so we can see whether the alt-screen was
    // actually entered and the render surface is sized.
    if (dbgOn()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = (term as any).element as HTMLElement | undefined;
      dbgLog(
        `key'${e.key}' buf=${term.buffer.active.type} ${term.cols}x${term.rows} el=${el?.offsetWidth ?? "?"}x${el?.offsetHeight ?? "?"} vis=${el?.offsetParent ? "Y" : "N"}`,
      );
    } // TEMP

    // Shift+Enter inserts a newline instead of submitting. xterm sends CR (\r)
    // for both Enter and Shift+Enter, so we send ESC+CR (\x1b\r) — the exact bytes
    // Claude Code's own /terminal-setup binds Shift+Enter to in VS Code (also an
    // xterm.js terminal), which Claude Code recognizes as chat:newline. Default
    // Enter (plain CR) still submits.
    // Ref: https://code.claude.com/docs/en/terminal-config
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      layer.pty?.write("\x1b\r");
      return handled(e);
    }
    if (!e.metaKey) return true;
    if (e.key === "c" && term.hasSelection()) {
      void writeText(term.getSelection());
      return handled(e);
    }
    if (e.key === "v") {
      void readText().then((text) => {
        const bracket = term.modes.bracketedPasteMode;
        if (text) {
          // Strip any embedded paste-end marker so content can't break out early,
          // and wrap in bracketed-paste when the app enabled it (so claude/zsh
          // treat it as a paste, not typed input).
          const safe = text.replace(/\x1b\[201~/g, "");
          layer.pty?.write(bracket ? `\x1b[200~${safe}\x1b[201~` : safe);
        } else if (bracket) {
          // No text — the clipboard likely holds an image. Send Ctrl+V (\x16),
          // exactly what works when the user presses Ctrl+V directly: it reaches
          // claude's own paste handler, which reads the image via osascript on
          // macOS. (An empty bracketed paste didn't trigger that.) Gated on
          // bracketed-paste mode so a plain shell isn't sent a stray Ctrl+V.
          layer.pty?.write("\x16");
        }
      });
      return handled(e);
    }
    return true;
  });

  // Clickable file paths (web-links only handles http/https). Matches tokens
  // with at least one slash and a file extension — `docs/x/foo.md`, `./src/a.ts`,
  // `/abs/p.rs`, `~/n.md`, `成果物/_社内検討/メール_土井さん.md`, optionally with a
  // `:line[:col]` suffix. Segments allow Unicode letters (\p{L}) so Japanese path
  // parts match; the extension stays ASCII so it never swallows trailing prose.
  // ⌘/Ctrl-click resolves it against the cwd and the host opens it (OS default app).
  const PATH_RE =
    /(?:~\/|\.{1,2}\/|\/)?[\p{L}\p{N}._\-@+]+(?:\/[\p{L}\p{N}._\-@+]+)+\.[A-Za-z0-9]{1,8}(?::\d+(?:[:.]\d+)?)?/gu;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      const first = buf.getLine(y - 1);
      if (!first) return callback(undefined);
      // A long path wraps across rows, but the provider runs per row. Skip
      // continuation rows (their logical line's START row emits one link that
      // spans all the rows) — otherwise a click on the wrapped tail matches only
      // a fragment (e.g. the `omi-…` inside `poric|omi-…`) and resolves wrong.
      if (first.isWrapped) return callback(undefined);
      // Rebuild the logical line = this row + following wrapped rows, tracking
      // each row's text and its offset in the joined string so match indices map
      // back to a (col, row) cell range.
      const rows: { y: number; line: IBufferLine; text: string; off: number }[] = [];
      let text = "";
      let yy = y;
      let line: IBufferLine | undefined = first;
      while (line) {
        const t = line.translateToString(true);
        rows.push({ y: yy, line, text: t, off: text.length });
        text += t;
        const nxt = buf.getLine(yy); // getLine is 0-based, so this is row yy+1
        if (nxt && nxt.isWrapped) {
          line = nxt;
          yy += 1;
        } else break;
      }
      const locate = (i: number) => {
        let r = rows[0];
        for (const cand of rows) {
          if (i >= cand.off) r = cand;
          else break;
        }
        return { col: colForStrIdx(r.line, i - r.off), y: r.y };
      };
      const links: ILink[] = [];
      // URL spans are owned by web-links (→ onOpenUrl). The path matcher must NOT
      // also claim a slice inside a URL (e.g. the `com/a.md` of `x.com/a.md`), or
      // a ⌘-click fires BOTH onOpenUrl and onOpenPath — the "opens in both" bug.
      const urlSpans: Array<[number, number]> = [];
      const URL_RE = /https?:\/\/\S+/gu;
      let um: RegExpExecArray | null;
      while ((um = URL_RE.exec(text)) !== null) urlSpans.push([um.index, um.index + um[0].length]);
      PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (urlSpans.some(([us, ue]) => start < ue && end > us)) continue; // inside a URL
        const raw = m[0];
        const s = locate(start);
        const e = locate(end); // exclusive
        links.push({
          text: raw,
          range: { start: { x: s.col + 1, y: s.y }, end: { x: e.col, y: e.y } },
          activate: (ev: MouseEvent) => {
            if (ev.metaKey || ev.ctrlKey) opts.onOpenPath?.(raw, layer.cwd ?? null);
          },
        });
      }
      callback(links);
    },
  });

  // Shift+click range-selection, implemented ourselves because xterm's native
  // shift-extend only fires when the app isn't tracking the mouse — and claude's
  // TUI tracks it (and on macOS xterm's force-selection modifier is Option, not
  // Shift). A capture-phase handler maps the pixel to a buffer cell: a plain
  // click records the anchor; Shift+click selects from the anchor to the clicked
  // cell (works regardless of mouse-tracking). Plain clicks pass through
  // untouched so normal focus / app mouse reporting still work.
  let anchor: { col: number; row: number } | null = null;
  const cellFromEvent = (e: MouseEvent): { col: number; row: number } | null => {
    const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen || !term.cols || !term.rows) return null;
    const r = screen.getBoundingClientRect();
    const cw = r.width / term.cols;
    const ch = r.height / term.rows;
    if (cw <= 0 || ch <= 0) return null;
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor((e.clientX - r.left) / cw)));
    const vrow = Math.max(0, Math.min(term.rows - 1, Math.floor((e.clientY - r.top) / ch)));
    return { col, row: term.buffer.active.viewportY + vrow };
  };
  host.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      const cell = cellFromEvent(e);
      if (!cell) return;
      if (e.shiftKey && anchor) {
        e.preventDefault();
        e.stopImmediatePropagation(); // don't let xterm also report this click
        const cols = term.cols;
        const aLin = anchor.row * cols + anchor.col;
        const bLin = cell.row * cols + cell.col;
        const [s, len] = aLin <= bLin ? [anchor, bLin - aLin + 1] : [cell, aLin - bLin + 1];
        term.select(s.col, s.row, len);
        // preventDefault above blocks the textarea from refocusing — restore it
        // so ⌘C reaches xterm and copies THIS selection (not a stale drag).
        term.focus();
      } else if (!e.shiftKey) {
        anchor = cell; // remember where a later Shift+click should extend from
      }
    },
    true,
  );

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

  term.onData((data) => {
    if (dbgOn()) dbgLog(`data:[${Array.from(data).map((c) => c.charCodeAt(0)).join(",")}] pty=${layer.pty ? "Y" : "N"}`); // TEMP
    layer.pty?.write(data);
  });
  return layer;
}

export function createBrowserLayer(url: string, onOpenExternal?: (url: string) => void): Layer {
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
  // Many sites (Gitea/GitHub/Google/banks…) refuse iframe embedding via
  // X-Frame-Options/CSP and show blank here — this opens the current URL in the
  // real browser instead.
  const ext = mkBtn("↗", "open in external browser");

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
  ext.addEventListener("click", () => onOpenExternal?.(input.value));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      go(input.value, true);
    }
  });

  bar.append(back, fwd, reload, ext, titleInput, input);
  el.appendChild(bar);

  // Fallback shown BEHIND the (transparent) iframe: when a site refuses embedding
  // (X-Frame-Options/CSP) the iframe stays empty and this shows through, instead
  // of a confusing blank white page. A loaded page's own background covers it.
  const content = document.createElement("div");
  content.className = "browser-content";
  const fallback = document.createElement("div");
  fallback.className = "browser-fallback";
  const fbMsg = document.createElement("div");
  fbMsg.className = "browser-fallback-msg";
  fbMsg.textContent = t("browser.blocked");
  const fbBtn = document.createElement("button");
  fbBtn.className = "browser-fallback-btn";
  fbBtn.textContent = t("browser.openExternal");
  fbBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  fbBtn.addEventListener("click", () => onOpenExternal?.(input.value));
  fallback.append(fbMsg, fbBtn);
  content.append(fallback, iframe);
  el.appendChild(content);

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
      if (dbgOn()) dbgLog(`OUT[${Array.from(bytes).slice(0, 48).join(",")}]${bytes.length > 48 ? "…" : ""} ${layer.title}`); // TEMP
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
    // Only fit/resize when the cell grid ACTUALLY changes. Fitting unconditionally
    // reflows xterm and re-resizes the PTY every call; if a ResizeObserver→fit
    // loop spins (or refit fires often), that floods a full-screen app like vim
    // with SIGWINCH + focus-report churn and it stops responding. proposeDimensions
    // tells us the target size without touching anything, so a no-op stays a no-op.
    const dims = layer.fit.proposeDimensions();
    if (!dims || (dims.cols === layer.term.cols && dims.rows === layer.term.rows)) return;
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

  // ● priority flag (leftmost): click cycles none→low→mid→high. The glyph/colour
  // is set on render from agent.priority; the card's data-prio drives the emphasis.
  const prioEl = document.createElement("button");
  prioEl.className = "agent-prio";
  prioEl.textContent = "○";
  prioEl.title = t("tip.priority");

  const titleEl = document.createElement("div");
  titleEl.className = "agent-title";
  titleEl.textContent = `agent ${index}`;
  titleEl.title = t("tip.title");

  const branchEl = document.createElement("span");
  branchEl.className = "agent-branch";

  const cpuEl = document.createElement("span");
  cpuEl.className = "agent-cpu";

  const runEl = document.createElement("button");
  runEl.className = "agent-run";
  runEl.textContent = "▶";
  runEl.title = t("tip.runAgent");

  // ▾ caret: opens the CLI chooser, grouped to the right of ▶ as a split button.
  // Hidden when only one preset exists (then the row shows just ▶).
  const agentSel = document.createElement("button");
  agentSel.className = "agent-caret"; // the ▾ glyph is drawn in CSS (crisp, exact size)
  agentSel.title = t("tip.agentSel");

  const closeEl = document.createElement("button");
  closeEl.className = "agent-close";
  closeEl.textContent = "×";
  closeEl.title = t("tip.closeAgent");

  // Title row: agent name + branch badge on the left; run/chooser/close on the
  // right. ▶ and the ▾ caret sit together as a split button (▶ runs the current
  // CLI, ▾ picks one). Branch lives here (not the path row) so the cwd has room.
  const runGroup = document.createElement("div");
  runGroup.className = "run-group";
  runGroup.append(runEl, agentSel);
  titleRow.appendChild(prioEl);
  titleRow.appendChild(titleEl);
  titleRow.appendChild(branchEl);
  titleRow.appendChild(runGroup);
  titleRow.appendChild(closeEl);

  const pathRow = document.createElement("div");
  pathRow.className = "agent-path-row";
  const pickEl = document.createElement("button");
  pickEl.className = "agent-pick";
  pickEl.textContent = t("agent.pick");
  pickEl.title = t("tip.pick");
  const openDirEl = document.createElement("button");
  openDirEl.className = "agent-pick"; // same compact button style
  openDirEl.textContent = t("agent.openDir");
  openDirEl.title = t("tip.openDir");
  const pathEl = document.createElement("input");
  pathEl.className = "agent-path";
  pathEl.placeholder = t("agent.pathPlaceholder");
  pathEl.spellcheck = false;
  // Path row: 📁 choose folder, 📂 reveal folder in Finder, then the cwd + status.
  pathRow.append(pickEl, openDirEl, pathEl, cpuEl);

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
    priority: 0,
    layers: [],
    active: 0,
    cardEl,
    headerEl,
    stackEl,
    titleEl,
    prioEl,
    branchEl,
    cpuEl,
    agentSel,
    runEl,
    closeEl,
    pathEl,
    pickEl,
    openDirEl,
    tabsEl,
  };
}
