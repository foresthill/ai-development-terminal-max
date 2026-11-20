// In-app file browser (Alt+O): browse the focused agent's working directory, see the
// current path, and click a file to open it in the built-in editor layer — a fast way to
// reach files the app or a Claude agent just created (e.g. generated .md), without hunting
// in the terminal. Read-only (listing only); the editor handles opening. Own module so
// app.ts doesn't grow (CLAUDE.md: new concerns go in their own module).
import { listDir, type DirEntry } from "./files";
import { toast } from "./ui";
import { t } from "./i18n";

export interface FilesPanelCtx {
  /** Where to start — the focused agent's live cwd (falls back to its set cwd / home). */
  cwd: string | null;
  home: string;
  /** Open an absolute path in the built-in editor layer. */
  openInEditor: (path: string) => void;
}

const stripTrailing = (p: string) => p.replace(/\/+$/, "") || "/";
const join = (dir: string, name: string) => `${stripTrailing(dir)}/${name}`;
const parentOf = (p: string) => {
  const s = stripTrailing(p);
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
};

export function openFilesPanel(ctx: FilesPanelCtx): void {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal modal-wide modal-files";
  box.innerHTML = `
    <div class="modal-title">📂 ${t("fb.title")}</div>
    <div class="fb-path" id="fb-path"></div>
    <input class="modal-input" id="fb-search" placeholder="${t("fb.search")}" spellcheck="false">
    <div id="fb-list" class="mem-list"></div>
    <div class="modal-row"><button id="fb-close" class="primary">${t("modal.ok")}</button></div>`;
  back.append(box);
  document.body.append(back);

  const pathEl = box.querySelector<HTMLElement>("#fb-path")!;
  const listEl = box.querySelector<HTMLElement>("#fb-list")!;
  const search = box.querySelector<HTMLInputElement>("#fb-search")!;

  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey, true);

  let dir = stripTrailing(ctx.cwd || ctx.home);
  let entries: DirEntry[] = [];

  const render = () => {
    pathEl.textContent = dir;
    const q = search.value.trim().toLowerCase();
    listEl.replaceChildren();

    const up = document.createElement("div");
    up.className = "fb-row fb-dir";
    up.textContent = "⬆ ..";
    up.addEventListener("click", () => void load(parentOf(dir)));
    listEl.appendChild(up);

    const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "fb-empty";
      empty.textContent = t("fb.empty");
      listEl.appendChild(empty);
    }
    for (const e of shown) {
      const row = document.createElement("div");
      row.className = e.is_dir ? "fb-row fb-dir" : "fb-row fb-file";
      row.textContent = (e.is_dir ? "📁 " : "📄 ") + e.name;
      row.title = join(dir, e.name);
      row.addEventListener("click", () => {
        if (e.is_dir) void load(join(dir, e.name));
        else {
          ctx.openInEditor(join(dir, e.name));
          close();
        }
      });
      listEl.appendChild(row);
    }
  };

  const load = async (next: string) => {
    try {
      entries = await listDir(next);
      dir = stripTrailing(next);
      render();
    } catch (e) {
      toast(t("fb.loadFail", String(e)), "error");
    }
  };

  search.addEventListener("keydown", (e) => e.stopPropagation());
  search.addEventListener("input", render);
  box.querySelector("#fb-close")!.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });

  void load(dir);
  setTimeout(() => search.focus(), 0);
}
