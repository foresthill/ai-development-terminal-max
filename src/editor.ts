// Editor layer: a DOM (CodeMirror 6) text editor, added as a Z-layer next to the
// terminal/browser layers. A DOM editor is normal HTML, so it repaints fine on every
// platform (including macOS 26, where terminal vim historically couldn't — wry#1848,
// now also fixed by the CEF engine). It doubles as a fast, always-resident alternative
// to launching a heavyweight external editor: the app is already running, so opening a
// file here is instant.
//
// Toolbar: file name (● when dirty) · language select · vim toggle · Open · Save · line:col.
// vim keybindings are opt-in (persisted per-user); undo/redo work both via ⌘Z / ⌘⇧Z and,
// in vim mode, via `u` / Ctrl-r.
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { vim } from "@replit/codemirror-vim";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import type { Layer } from "./agent";
import { readFile, writeFile, pickFile, pickSavePath } from "./files";
import { toast } from "./ui";
import { t } from "./i18n";

const basename = (p: string | null | undefined) => (p ?? "").split("/").pop() || "";

/// Manual language choices for the toolbar select. `auto` defers to langForPath (by
/// extension); the rest force a mode for files whose extension doesn't say (or is wrong).
const LANGS: { id: string; label: string; ext: () => Extension[] }[] = [
  { id: "auto", label: t("editor.langAuto"), ext: () => [] },
  { id: "ts", label: "TS / JS", ext: () => [javascript({ typescript: true, jsx: true })] },
  { id: "json", label: "JSON", ext: () => [json()] },
  { id: "md", label: "Markdown", ext: () => [markdown()] },
  { id: "py", label: "Python", ext: () => [python()] },
  { id: "rs", label: "Rust", ext: () => [rust()] },
  { id: "html", label: "HTML", ext: () => [html()] },
  { id: "css", label: "CSS", ext: () => [css()] },
  { id: "text", label: "Text", ext: () => [] },
];

/// Pick a CodeMirror language extension from the file extension (best-effort; plain
/// text when unknown). Kept small — more languages can be added as needed.
function langForPath(path: string | null): Extension[] {
  const ext = basename(path).split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: ext === "tsx" })];
    case "json":
      return [json()];
    case "md":
    case "markdown":
      return [markdown()];
    case "py":
      return [python()];
    case "rs":
      return [rust()];
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return [html()];
    case "css":
      return [css()];
    default:
      return [];
  }
}

// vim keybindings are an opt-in, per-user preference persisted in localStorage. Default
// off so the editor stays neutral (CLAUDE.md: keep the tool opinion-free); a user who
// flips the toolbar toggle keeps vim on for every editor they open afterwards.
const VIM_KEY = "aidt-editor-vim";
function getVimPref(): boolean {
  try {
    return localStorage.getItem(VIM_KEY) === "1";
  } catch {
    return false;
  }
}
function setVimPref(on: boolean): void {
  try {
    localStorage.setItem(VIM_KEY, on ? "1" : "0");
  } catch {
    /* private mode / blocked storage — the in-session toggle still works */
  }
}

// Theme hook: let the editor follow the app's CSS tokens. Colours are set in styles.css
// on `.cm-editor` / `.cm-gutters` via var(--bg)/var(--text)/… so themes just work.
const appTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px" },
  ".cm-scroller": { fontFamily: 'Menlo, "SF Mono", "JetBrains Mono", monospace' },
});

/// Build an editor layer bound to `path` (null = untitled, saved via a dialog). The
/// file is read asynchronously after the view is created.
export function createEditorLayer(path: string | null): Layer {
  const el = document.createElement("div");
  el.className = "layer layer-editor";

  const bar = document.createElement("div");
  bar.className = "editor-bar";

  const nameEl = document.createElement("span");
  nameEl.className = "editor-name";

  const undoBtn = document.createElement("button");
  undoBtn.className = "editor-act";
  undoBtn.textContent = "↶";
  undoBtn.title = t("editor.undo");
  const redoBtn = document.createElement("button");
  redoBtn.className = "editor-act";
  redoBtn.textContent = "↷";
  redoBtn.title = t("editor.redo");
  const findBtn = document.createElement("button");
  findBtn.className = "editor-act";
  findBtn.textContent = "⌕";
  findBtn.title = t("editor.find");

  const langSel = document.createElement("select");
  langSel.className = "editor-lang";
  langSel.title = t("editor.lang");
  for (const l of LANGS) {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = l.label;
    langSel.append(o);
  }
  langSel.value = "auto";

  const vimBtn = document.createElement("button");
  vimBtn.className = "editor-vim";
  vimBtn.textContent = "vim";
  vimBtn.title = t("editor.vimTip");

  const openBtn = document.createElement("button");
  openBtn.className = "editor-open";
  openBtn.textContent = t("editor.open");

  const saveBtn = document.createElement("button");
  saveBtn.className = "editor-save";
  saveBtn.textContent = t("editor.save");

  const posEl = document.createElement("span");
  posEl.className = "editor-pos";
  posEl.textContent = "1:1";

  bar.append(nameEl, posEl, undoBtn, redoBtn, findBtn, langSel, vimBtn, openBtn, saveBtn);

  const host = document.createElement("div");
  host.className = "editor-host";
  el.append(bar, host);

  const layer: Layer = {
    id: "ed-" + Math.random().toString(36).slice(2, 10),
    kind: "editor",
    title: basename(path) || t("editor.untitled"),
    el,
    started: true,
    filePath: path,
    dirty: false,
  };

  const refreshName = () => {
    const name = basename(layer.filePath ?? "") || t("editor.untitled");
    nameEl.textContent = layer.dirty ? `${name} ●` : name;
    layer.title = name;
  };

  const langComp = new Compartment();
  const vimComp = new Compartment();

  const markDirty = EditorView.updateListener.of((u) => {
    if (u.docChanged && !layer.dirty) {
      layer.dirty = true;
      refreshName();
    }
  });

  const trackPos = EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.docChanged) {
      const head = u.state.selection.main.head;
      const ln = u.state.doc.lineAt(head);
      posEl.textContent = `${ln.number}:${head - ln.from + 1}`;
    }
  });

  const doSave = async () => {
    let p = layer.filePath ?? null;
    if (!p) {
      p = await pickSavePath();
      if (!p) return;
      layer.filePath = p;
    }
    try {
      await writeFile(p, view.state.doc.toString());
      layer.dirty = false;
      refreshName();
      toast(t("editor.saved", basename(p)));
    } catch (e) {
      toast(t("editor.saveFail", String(e)), "error");
    }
  };

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: "",
      extensions: [
        // vim must precede basicSetup so its keymap wins when enabled; the compartment
        // lets the toolbar toggle it live without rebuilding the view.
        vimComp.of(getVimPref() ? vim() : []),
        basicSetup,
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (void doSave(), true) }]),
        markDirty,
        trackPos,
        appTheme,
        langComp.of(langForPath(path)),
      ],
    }),
  });
  layer.editorView = view;

  // Load a file into THIS view (used by the Open button). Refuses to clobber unsaved
  // changes — save or discard first. Resets language to auto for the new file.
  const loadPath = async (p: string) => {
    try {
      const content = await readFile(p);
      layer.filePath = p;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
      view.dispatch({ effects: langComp.reconfigure(langForPath(p)) });
      langSel.value = "auto";
      layer.dirty = false;
      refreshName();
    } catch (e) {
      toast(t("editor.loadFail", String(e)), "error");
    }
  };

  // Keep clicks on the toolbar from bubbling into the layer's drag/focus handling.
  for (const node of [undoBtn, redoBtn, findBtn, langSel, vimBtn, openBtn, saveBtn]) {
    node.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  undoBtn.addEventListener("click", () => {
    undo(view);
    view.focus();
  });
  redoBtn.addEventListener("click", () => {
    redo(view);
    view.focus();
  });
  findBtn.addEventListener("click", () => {
    openSearchPanel(view);
  });

  langSel.addEventListener("change", () => {
    const id = langSel.value;
    const exts = id === "auto" ? langForPath(layer.filePath ?? null) : (LANGS.find((l) => l.id === id)?.ext() ?? []);
    view.dispatch({ effects: langComp.reconfigure(exts) });
    view.focus();
  });

  const refreshVimBtn = () => vimBtn.classList.toggle("on", getVimPref());
  vimBtn.addEventListener("click", () => {
    const on = !getVimPref();
    setVimPref(on);
    view.dispatch({ effects: vimComp.reconfigure(on ? vim() : []) });
    refreshVimBtn();
    view.focus();
  });
  refreshVimBtn();

  openBtn.addEventListener("click", async () => {
    if (layer.dirty) {
      toast(t("editor.saveFirst"), "error");
      return;
    }
    const p = await pickFile(layer.filePath ? layer.filePath.replace(/\/[^/]*$/, "") : undefined);
    if (p) await loadPath(p);
    view.focus();
  });

  saveBtn.addEventListener("click", () => void doSave());
  refreshName();

  if (path) {
    void readFile(path)
      .then((content) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        layer.dirty = false;
        refreshName();
      })
      .catch((e) => toast(t("editor.loadFail", String(e)), "error"));
  }

  return layer;
}
