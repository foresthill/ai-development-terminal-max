// Claude session overview (the real "long-term memory"). See
// docs/2026-11-10-claude-session-harvest-longterm-memory.md.
//
// The user's requirement: long-term memory is NOT hand-typed notes — it is the app
// automatically harvesting Claude Code's own sessions and PRESERVING them durably,
// because Claude's session storage is unreliable (sessions can fail to resume / vanish).
// So this panel shows a global survey of every Claude session we've seen (across all
// projects), reads from our durable store (merged with the live scan), flags any session
// Claude has since lost, and lets a human resume one — human-in-the-loop, no autonomous
// injection (see CLAUDE.md). The old hand-entry form was removed: the user won't use it.
//
// Portability is kept: the preserved sessions export to Markdown/JSON (no lock-in).
import {
  memory,
  memoriesToJson,
  memoriesToMarkdown,
  memoriesFromJson,
} from "./memory";
import {
  overviewSessions,
  SESSION_TAG,
  type MergedSession,
} from "./claude-sessions";
import { distill } from "./distill";
import { readFile, writeFile, pickFile, pickSavePath } from "./files";
import { toast } from "./ui";
import { t, getLang } from "./i18n";

export interface MemoryPanelCtx {
  /** Current project's folder path, to offer a "this project" filter (optional — the
   *  overview is global by default). */
  projectId?: string | null;
  projectLabel?: string | null;
  /** Type text into the focused agent's terminal (no auto-submit). */
  sendToAgent: (text: string) => boolean;
}

export function openMemoryPanel(ctx: MemoryPanelCtx): void {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal modal-wide modal-memory";

  const hasProject = !!(ctx.projectId && ctx.projectLabel);
  box.innerHTML = `
    <div class="modal-title">🧠 ${t("sess.title")}</div>
    <div class="mem-hint">${t("sess.hint")}</div>
    <div class="mem-tabs">
      <button class="mem-tab" data-view="all">${t("sess.scopeAll")}</button>
      ${hasProject ? `<button class="mem-tab" data-view="this">${t("sess.scopeThis")} · ${escapeHtml(ctx.projectLabel!)}</button>` : ""}
      <button class="mem-tab" data-view="insights">${t("sess.tabInsights")}</button>
      <span class="mem-count" id="sess-count"></span>
      <button id="sess-refresh" class="mem-btn">${t("sess.refresh")}</button>
    </div>
    <input class="modal-input" id="sess-search" placeholder="${t("sess.search")}" spellcheck="false">
    <div id="mem-list" class="mem-list"></div>
    <div class="mem-io">
      <span class="mem-io-label">${t("mem.portable")}</span>
      <button id="mem-exp-md" class="mem-btn">${t("mem.exportMd")}</button>
      <button id="mem-exp-json" class="mem-btn">${t("mem.exportJson")}</button>
      <button id="mem-imp" class="mem-btn">${t("mem.import")}</button>
    </div>
    <div class="modal-row"><button id="mem-close" class="primary">${t("modal.ok")}</button></div>`;
  back.append(box);
  document.body.append(back);

  const listEl = box.querySelector<HTMLElement>("#mem-list")!;
  const searchEl = box.querySelector<HTMLInputElement>("#sess-search")!;
  const countEl = box.querySelector<HTMLElement>("#sess-count")!;
  const tabEls = Array.from(box.querySelectorAll<HTMLButtonElement>(".mem-tab"));

  type View = "all" | "this" | "insights";
  let view: View = "all";
  let sessions: MergedSession[] = [];

  /// A session belongs to "this project" when its cwd is the project root or nested
  /// under it (agents run in worktrees below the root).
  const inThisProject = (s: MergedSession): boolean => {
    const root = ctx.projectId;
    if (!root) return true;
    return s.cwd === root || s.cwd.startsWith(root + "/");
  };

  const matchesSearch = (s: MergedSession, q: string): boolean => {
    if (!q) return true;
    const hay = `${s.title} ${s.project} ${s.gitBranch} ${s.slug}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
  };

  const fmtDate = (iso: string): string => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso || "";
    return d.toLocaleString(getLang() === "ja" ? "ja-JP" : undefined);
  };

  const render = () => {
    searchEl.style.display = view === "insights" ? "none" : "";
    if (view === "insights") {
      renderInsights();
      return;
    }
    const q = searchEl.value.trim();
    const rows = sessions.filter((s) => (view === "all" || inThisProject(s)) && matchesSearch(s, q));
    countEl.textContent = t("sess.count", rows.length);
    listEl.innerHTML = "";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = t("sess.empty");
      listEl.append(empty);
      return;
    }
    // Orca-style: group by project, newest project activity first.
    const buckets = new Map<string, MergedSession[]>();
    for (const s of rows) {
      const key = s.project || s.cwd || "—";
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(s);
    }
    const order = [...buckets.keys()].sort((a, b) => {
      const la = buckets.get(a)![0]?.lastTs ?? "";
      const lb = buckets.get(b)![0]?.lastTs ?? "";
      return lb.localeCompare(la);
    });
    for (const key of order) {
      const header = document.createElement("div");
      header.className = "mem-session";
      header.textContent = key;
      listEl.append(header);
      for (const s of buckets.get(key)!) listEl.append(sessionRow(s));
    }
  };

  const sessionRow = (s: MergedSession): HTMLElement => {
    const el = document.createElement("div");
    el.className = "mem-item" + (s.lostByClaude ? " mem-lost" : "");
    const head = document.createElement("div");
    head.className = "mem-head";
    const title = document.createElement("span");
    title.className = "mem-item-title";
    title.textContent = s.title || s.slug || s.sessionId;
    const badge = document.createElement("span");
    badge.className = "mem-badge";
    badge.textContent = t("sess.msgs", s.messages);
    head.append(title, badge);
    el.append(head);

    const meta = document.createElement("div");
    meta.className = "mem-body mem-meta";
    const bits = [s.gitBranch, fmtDate(s.lastTs)].filter(Boolean);
    meta.textContent = bits.join(" · ");
    el.append(meta);

    const acts = document.createElement("div");
    acts.className = "mem-acts";
    if (s.lostByClaude) {
      const lost = document.createElement("span");
      lost.className = "mem-lost-tag";
      lost.textContent = "⚠ " + t("sess.lost");
      acts.append(lost);
    }
    const resume = mkBtn(t("sess.resume"), () => {
      // Hand the human the exact resume command for this session — even one Claude's own
      // UI has forgotten — in the right directory. They press Enter.
      const cmd = `cd "${s.cwd}" && claude --resume ${s.sessionId}`;
      if (ctx.sendToAgent(cmd)) toast(t("sess.resumed"));
      else toast(t("mem.noAgent"), "error");
    });
    acts.append(resume);
    el.append(acts);
    return el;
  };

  // Insights view: the heuristic "learning" over everything preserved (distill.ts).
  const chipRow = (label: string, items: string[]): HTMLElement => {
    const row = document.createElement("div");
    row.className = "ins-chips";
    const lab = document.createElement("span");
    lab.className = "ins-chip-label";
    lab.textContent = label;
    row.append(lab);
    for (const it of items) {
      const c = document.createElement("span");
      c.className = "ins-chip";
      c.textContent = it;
      row.append(c);
    }
    return row;
  };

  const renderInsights = () => {
    const ins = distill(sessions);
    const g = ins.global;
    countEl.textContent = t("sess.count", g.sessions);
    listEl.innerHTML = "";
    if (!g.sessions) {
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = t("ins.empty");
      listEl.append(empty);
      return;
    }
    // Overall card.
    const card = document.createElement("div");
    card.className = "mem-item ins-card";
    const h = document.createElement("div");
    h.className = "mem-head";
    const title = document.createElement("span");
    title.className = "mem-item-title";
    title.textContent = t("ins.overall");
    h.append(title);
    card.append(h);
    const sum = document.createElement("div");
    sum.className = "mem-body";
    sum.textContent = t("ins.summary", g.sessions, g.messages, g.projects);
    card.append(sum);
    if (g.busiest.length) card.append(chipRow(t("ins.busiest"), g.busiest.map((b) => `${b.project} (${b.sessions})`)));
    if (g.topics.length) card.append(chipRow(t("ins.topics"), g.topics.map((tp) => `${tp.term} (${tp.count})`)));
    listEl.append(card);
    // By project.
    const hd = document.createElement("div");
    hd.className = "mem-session";
    hd.textContent = t("ins.byProject");
    listEl.append(hd);
    for (const p of ins.projects) {
      const el = document.createElement("div");
      el.className = "mem-item";
      const head = document.createElement("div");
      head.className = "mem-head";
      const ttl = document.createElement("span");
      ttl.className = "mem-item-title";
      ttl.textContent = p.project;
      const badge = document.createElement("span");
      badge.className = "mem-badge";
      badge.textContent = t("ins.projLine", p.sessions, p.messages);
      head.append(ttl, badge);
      el.append(head);
      const meta = document.createElement("div");
      meta.className = "mem-body mem-meta";
      const bits: string[] = [];
      if (p.branches.length) bits.push(`${t("ins.branches")}: ${p.branches.join(", ")}`);
      bits.push(`${t("ins.active")}: ${fmtDate(p.firstTs)} → ${fmtDate(p.lastTs)}`);
      meta.textContent = bits.join(" · ");
      el.append(meta);
      listEl.append(el);
    }
  };

  // Portable export/import of the PRESERVED sessions — no lock-in. These are the durable
  // session memories (collective scope, tagged claude-session).
  const sessionMemories = () =>
    memory.query({ scope: "collective", limit: 100000 }).filter((m) => m.tags.includes(SESSION_TAG));

  const stamp = new Date().toISOString().slice(0, 10);
  const exportTo = async (fmt: "md" | "json") => {
    const rows = sessionMemories();
    if (!rows.length) {
      toast(t("mem.exportEmpty"), "error");
      return;
    }
    const path = await pickSavePath(`aidt-claude-sessions-${stamp}.${fmt}`);
    if (!path) return;
    const content = fmt === "md" ? memoriesToMarkdown(rows, "Claude Sessions") : memoriesToJson(rows);
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
      await reload();
    } catch (e) {
      toast(t("mem.importFail", String(e)), "error");
    }
  };

  const reload = async () => {
    listEl.innerHTML = `<div class="mem-empty">…</div>`;
    sessions = await overviewSessions();
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

  const selectTab = (v: View) => {
    view = v;
    for (const b of tabEls) b.classList.toggle("active", b.dataset.view === v);
    render();
  };
  for (const b of tabEls) b.addEventListener("click", () => selectTab(b.dataset.view as View));
  selectTab("all");

  searchEl.addEventListener("input", render);
  box.querySelector("#sess-refresh")!.addEventListener("click", () => void reload());
  box.querySelector("#mem-exp-md")!.addEventListener("click", () => void exportTo("md"));
  box.querySelector("#mem-exp-json")!.addEventListener("click", () => void exportTo("json"));
  box.querySelector("#mem-imp")!.addEventListener("click", () => void importFrom());
  box.querySelector("#mem-close")!.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });

  void reload();
  setTimeout(() => searchEl.focus(), 0);
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
