// Editor layer: a DOM (CodeMirror 6) text editor, added as a Z-layer next to the
// terminal/browser layers. This is the way to edit files on macOS 26, where terminal
// vim can't repaint (WKWebView compositor bug wry#1848 — see
// docs/2026-10-24-macos26-wkwebview-altscreen.md). A DOM editor is normal HTML, so it
// repaints fine on every platform. On Windows/Linux/older macOS vim still works too.
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import type { Layer } from "./agent";
import { readFile, writeFile, pickSavePath } from "./files";
import { toast } from "./ui";
import { t } from "./i18n";

const basename = (p: string | null | undefined) => (p ?? "").split("/").pop() || "";

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
  const saveBtn = document.createElement("button");
  saveBtn.className = "editor-save";
  saveBtn.textContent = t("editor.save");
  bar.append(nameEl, saveBtn);

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

  const markDirty = EditorView.updateListener.of((u) => {
    if (u.docChanged && !layer.dirty) {
      layer.dirty = true;
      refreshName();
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
        basicSetup,
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (void doSave(), true) }]),
        markDirty,
        appTheme,
        ...langForPath(path),
      ],
    }),
  });
  layer.editorView = view;

  saveBtn.addEventListener("mousedown", (e) => e.stopPropagation());
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
