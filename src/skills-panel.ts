// Claude Code skills browser (Alt+S): list every discoverable skill — the focused
// project's `.claude/skills`, the user's `~/.claude/skills`, and plugin skills — and on
// click TYPE its slash form into the focused agent's terminal. The human presses Enter
// (no auto-run), the same human-driven injection the memory/command palettes use (see
// CLAUDE.md). This is the dynamic, filesystem-scanned companion to commands-palette.ts.
// Own module so app.ts doesn't grow (CLAUDE.md: new concerns go in their own module).
import { claudeSkills, skillInvocation, type SkillInfo } from "./skills";
import { toast } from "./ui";
import { t } from "./i18n";

export interface SkillsPanelCtx {
  /** Focused project's folder path, so project `.claude/skills` are included. */
  projectCwd?: string | null;
  /** Type text into the focused agent's terminal (no auto-submit). Returns false when
   *  there is no terminal to type to. */
  sendToAgent: (text: string) => boolean;
}

const SOURCE_LABEL: Record<SkillInfo["source"], string> = {
  project: "sk.srcProject",
  user: "sk.srcUser",
  plugin: "sk.srcPlugin",
};
const SOURCE_ORDER: SkillInfo["source"][] = ["project", "user", "plugin"];

export function openSkillsPanel(ctx: SkillsPanelCtx): void {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal modal-wide modal-skills";
  box.innerHTML = `
    <div class="modal-title">🧩 ${t("sk.title")}</div>
    <div class="mem-hint">${t("sk.hint")}</div>
    <div class="mem-tabs">
      <span class="mem-count" id="sk-count"></span>
      <button id="sk-refresh" class="mem-btn">${t("sess.refresh")}</button>
    </div>
    <input class="modal-input" id="sk-search" placeholder="${t("sk.search")}" spellcheck="false">
    <div id="sk-list" class="mem-list"></div>
    <div class="modal-row"><button id="sk-close" class="primary">${t("modal.ok")}</button></div>`;
  back.append(box);
  document.body.append(back);

  const listEl = box.querySelector<HTMLElement>("#sk-list")!;
  const searchEl = box.querySelector<HTMLInputElement>("#sk-search")!;
  const countEl = box.querySelector<HTMLElement>("#sk-count")!;

  let skills: SkillInfo[] = [];

  const matches = (s: SkillInfo, q: string): boolean => {
    if (!q) return true;
    const hay = `${s.name} ${s.description} ${s.plugin} ${s.source}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
  };

  const render = () => {
    const q = searchEl.value.trim();
    const rows = skills.filter((s) => matches(s, q));
    countEl.textContent = t("sk.count", rows.length);
    listEl.innerHTML = "";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = skills.length ? t("sk.noMatch") : t("sk.empty");
      listEl.append(empty);
      return;
    }
    for (const src of SOURCE_ORDER) {
      const group = rows.filter((s) => s.source === src);
      if (!group.length) continue;
      const header = document.createElement("div");
      header.className = "mem-session";
      header.textContent = `${t(SOURCE_LABEL[src])} · ${group.length}`;
      listEl.append(header);
      for (const s of group) listEl.append(skillRow(s));
    }
  };

  const skillRow = (s: SkillInfo): HTMLElement => {
    const el = document.createElement("div");
    el.className = "mem-item sk-item";
    el.tabIndex = 0;
    const head = document.createElement("div");
    head.className = "mem-head";
    const name = document.createElement("span");
    name.className = "mem-item-title sk-name";
    name.textContent = skillInvocation(s);
    head.append(name);
    if (s.plugin) {
      const badge = document.createElement("span");
      badge.className = "mem-badge";
      badge.textContent = s.plugin;
      head.append(badge);
    }
    el.append(head);
    if (s.description) {
      const body = document.createElement("div");
      body.className = "mem-body sk-desc";
      body.textContent = s.description;
      el.append(body);
    }
    const insert = () => {
      if (ctx.sendToAgent(skillInvocation(s))) {
        toast(t("sk.sent", skillInvocation(s)));
        close();
      } else {
        toast(t("cmd.noAgent"), "error");
      }
    };
    el.addEventListener("click", insert);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        insert();
      }
    });
    return el;
  };

  const reload = async () => {
    listEl.innerHTML = `<div class="mem-empty">…</div>`;
    skills = await claudeSkills(ctx.projectCwd ?? null);
    render();
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

  searchEl.addEventListener("input", render);
  box.querySelector("#sk-refresh")!.addEventListener("click", () => void reload());
  box.querySelector("#sk-close")!.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });

  void reload();
  setTimeout(() => searchEl.focus(), 0);
}
