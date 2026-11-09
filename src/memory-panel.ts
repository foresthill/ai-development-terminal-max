// Memory panel (Phase 1 UI): sediment & recall a project's "personal unconscious".
// See docs/2026-11-08-four-layer-memory-architecture.md. Kept in its own module so
// app.ts doesn't grow; it talks to the store (memory.ts) directly and gets just a
// projectId, a label, and a human-driven "type this into the focused agent" hook.
//
// Recall is human-in-the-loop by design: "→ agent" TYPES a memory into the focused
// terminal WITHOUT submitting, so the person edits/sends it. Autonomous injection
// is intentionally not built (see CLAUDE.md).
import {
  memory,
  memoriesToJson,
  memoriesToMarkdown,
  memoriesFromJson,
  SHORT_TERM_TTL_MS,
  type Memory,
  type MemoryKind,
  type MemoryScope,
} from "./memory";
import { readFile, writeFile, pickFile, pickSavePath } from "./files";
import { toast } from "./ui";
import { t } from "./i18n";

export interface MemoryPanelCtx {
  /** Stable per-project key — the project's folder path (survives restarts). */
  projectId: string;
  projectLabel: string;
  /** Type text into the focused agent's terminal (no auto-submit). */
  sendToAgent: (text: string) => boolean;
}

const KINDS: MemoryKind[] = ["note", "summary", "decision", "convention", "goal"];

export function openMemoryPanel(ctx: MemoryPanelCtx): void {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal modal-wide modal-memory";

  const kindOpts = KINDS.map((k) => `<option value="${k}">${t("mem.kind." + k)}</option>`).join("");
  box.innerHTML = `
    <div class="modal-title">🧠 ${t("mem.title")} — ${escapeHtml(ctx.projectLabel)}</div>
    <div class="mem-tabs">
      <button class="mem-tab" data-scope="personal">${t("mem.tabLong")}</button>
      <button class="mem-tab" data-scope="conscious">${t("mem.tabShort")}</button>
    </div>
    <div class="mem-add">
      <input class="modal-input" id="mem-title" placeholder="${t("mem.phTitle")}" spellcheck="false">
      <textarea class="modal-input" id="mem-body" rows="2" placeholder="${t("mem.phBody")}" spellcheck="false"></textarea>
      <div class="mem-add-row">
        <select class="modal-input" id="mem-kind">${kindOpts}</select>
        <input class="modal-input" id="mem-tags" placeholder="${t("mem.phTags")}" spellcheck="false">
        <button id="mem-save" class="primary">${t("mem.save")}</button>
      </div>
    </div>
    <div class="set-section">${t("mem.listTitle")}</div>
    <div class="mem-io">
      <span class="mem-io-label">${t("mem.portable")}</span>
      <button id="mem-exp-md" class="mem-btn">${t("mem.exportMd")}</button>
      <button id="mem-exp-json" class="mem-btn">${t("mem.exportJson")}</button>
      <button id="mem-imp" class="mem-btn">${t("mem.import")}</button>
    </div>
    <div id="mem-list" class="mem-list"></div>
    <div class="modal-row"><button id="mem-close" class="primary">${t("modal.ok")}</button></div>`;
  back.append(box);
  document.body.append(back);

  const listEl = box.querySelector<HTMLElement>("#mem-list")!;
  const titleEl = box.querySelector<HTMLInputElement>("#mem-title")!;
  const bodyEl = box.querySelector<HTMLTextAreaElement>("#mem-body")!;
  const kindEl = box.querySelector<HTMLSelectElement>("#mem-kind")!;
  const tagsEl = box.querySelector<HTMLInputElement>("#mem-tags")!;
  const tabEls = Array.from(box.querySelectorAll<HTMLButtonElement>(".mem-tab"));

  // Which layer the panel is showing: long-term (personal, permanent) or short-term
  // (conscious, auto-recorded + TTL'd). The add form writes into the active layer.
  let scope: MemoryScope = "personal";

  const renderList = () => {
    const rows = memory.query({ scope, projectId: ctx.projectId, limit: 200 });
    listEl.innerHTML = "";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = scope === "conscious" ? t("mem.emptyShort") : t("mem.empty");
      listEl.append(empty);
      return;
    }
    for (const m of rows) listEl.append(row(m));
  };

  const row = (m: Memory): HTMLElement => {
    const el = document.createElement("div");
    el.className = "mem-item";
    const head = document.createElement("div");
    head.className = "mem-head";
    const title = document.createElement("span");
    title.className = "mem-item-title";
    title.textContent = m.title;
    const badge = document.createElement("span");
    badge.className = "mem-badge";
    badge.textContent = `${t("mem.kind." + m.kind)} · ★${m.salience}`;
    head.append(title, badge);
    el.append(head);
    if (m.body) {
      const body = document.createElement("div");
      body.className = "mem-body";
      body.textContent = m.body;
      el.append(body);
    }
    const acts = document.createElement("div");
    acts.className = "mem-acts";
    const send = mkBtn(t("mem.send"), () => {
      const text = m.body ? `${m.title}: ${m.body}` : m.title;
      if (ctx.sendToAgent(text)) {
        memory.reinforce(m.id); // recalling something reinforces it
        toast(t("mem.sent"));
        renderList();
      } else {
        toast(t("mem.noAgent"), "error");
      }
    });
    const boost = mkBtn(t("mem.reinforce"), () => {
      memory.reinforce(m.id);
      renderList();
    });
    const del = mkBtn(t("mem.del"), () => {
      memory.delete(m.id);
      renderList();
    });
    del.classList.add("mem-del");
    acts.append(send, boost, del);
    el.append(acts);
    return el;
  };

  const save = () => {
    const title = titleEl.value.trim();
    if (!title) {
      titleEl.focus();
      return;
    }
    memory.write({
      scope,
      projectId: ctx.projectId,
      kind: kindEl.value as MemoryKind,
      title,
      body: bodyEl.value,
      tags: tagsEl.value.split(",").map((s) => s.trim()).filter(Boolean),
      salience: 1, // a human-written memory starts above auto-sediment
      // Short-term entries expire; long-term are permanent.
      ttlMs: scope === "conscious" ? SHORT_TERM_TTL_MS : undefined,
    });
    titleEl.value = "";
    bodyEl.value = "";
    tagsEl.value = "";
    toast(t("mem.saved"));
    renderList();
    titleEl.focus();
  };

  // Portable export/import — your memory is never locked into this app. MD is for
  // reading (Obsidian/Notion); JSON is lossless and re-importable anywhere.
  const safeName =
    ctx.projectLabel.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "project";
  const stamp = new Date().toISOString().slice(0, 10);

  const exportTo = async (fmt: "md" | "json") => {
    // Export the whole project memory (both layers) — full portability.
    const rows = memory.query({ projectId: ctx.projectId, limit: 100000 });
    if (!rows.length) {
      toast(t("mem.exportEmpty"), "error");
      return;
    }
    const path = await pickSavePath(`aidt-memory-${safeName}-${stamp}.${fmt}`);
    if (!path) return;
    const content =
      fmt === "md" ? memoriesToMarkdown(rows, `Memory — ${ctx.projectLabel}`) : memoriesToJson(rows);
    try {
      await writeFile(path, content);
      toast(t("mem.exported"));
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const importFrom = async () => {
    const path = await pickFile();
    if (!path) return;
    try {
      const n = memory.importMany(memoriesFromJson(await readFile(path)));
      toast(t("mem.imported", n));
      renderList();
    } catch (e) {
      toast(t("mem.importFail", String(e)), "error");
    }
  };

  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey, true);
  const selectTab = (s: MemoryScope) => {
    scope = s;
    for (const b of tabEls) b.classList.toggle("active", b.dataset.scope === s);
    renderList();
  };
  for (const b of tabEls) b.addEventListener("click", () => selectTab(b.dataset.scope as MemoryScope));
  selectTab("personal");

  box.querySelector("#mem-save")!.addEventListener("click", save);
  box.querySelector("#mem-exp-md")!.addEventListener("click", () => void exportTo("md"));
  box.querySelector("#mem-exp-json")!.addEventListener("click", () => void exportTo("json"));
  box.querySelector("#mem-imp")!.addEventListener("click", () => void importFrom());
  box.querySelector("#mem-close")!.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });

  renderList();
  setTimeout(() => titleEl.focus(), 0);
}

function mkBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "mem-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
