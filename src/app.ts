// Orchestrator. Two-level model: Project (repo/folder) -> Agent (git worktree) ->
// Layer (Z-depth terminal/browser). Rendering lives in render.ts, persistence in
// persistence.ts, guardrail policy in guard.ts. This file owns state + lifecycle.
import {
  Agent,
  Layer,
  createAgent,
  createTerminalLayer,
  createBrowserLayer,
  startLayer,
  fitLayer,
  disposeLayer,
  basename,
  startTitleEdit,
} from "./agent";
import { Project, createProject } from "./project";
import { handleSubagentEvent, clearSubagentLayers } from "./subagent";
import { defaultShell, homeDir, agentStats } from "./pty";
import { isGitRepo, gitClone, createWorktree, writeAidtSettings, currentBranch } from "./git";
import { listen } from "@tauri-apps/api/event";
import { askText, toast, pickDirectory, openSettings } from "./ui";
import { GUARD_PRESETS, effectiveDeny } from "./guard";
import { t, getLang, setLang } from "./i18n";
import { renderAll, RenderCtx, Mode, View, PermMode } from "./render";
import {
  buildSnapshot,
  saveSnap,
  loadSnap,
  saveProjects,
  loadProjects,
  SavedProject,
} from "./persistence";

const ymd = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

// Default CLI agents selectable per window. Editable in Settings; persisted.
export interface AgentPreset {
  label: string;
  cmd: string;
}
const DEFAULT_AGENT_PRESETS: AgentPreset[] = [
  { label: "claude", cmd: "claude" },
  { label: "aider", cmd: "aider" },
  { label: "codex", cmd: "codex" },
  { label: "gemini", cmd: "gemini" },
];

export class App {
  private projects: Project[] = [];
  private ap = 0;
  private focused = 0;
  private mode: Mode = "overview";
  private view: View = "project";
  private layout: "square" | "fit" = "square";
  private permMode: PermMode = "auto";
  private guardrails = false;
  private subagentNest = false;
  private agentCmd = "claude";
  private agentPresets: AgentPreset[] = [...DEFAULT_AGENT_PRESETS];
  private saved: SavedProject[] = [];
  private presets = new Set<string>(GUARD_PRESETS.map((p) => p.id));
  private customDeny = "";
  private shell = "/bin/zsh";
  private home = "";
  private agentSeq = 1;
  private resizeTimer: number | undefined;

  private grid: HTMLElement;
  private macroEl: HTMLElement;
  private stripEl: HTMLElement;
  private countEl: HTMLElement;
  private btnLayout: HTMLElement;
  private btnGuard: HTMLElement;
  private btnNest: HTMLElement;
  private permSelect: HTMLSelectElement;
  private resizeObs: ResizeObserver;

  constructor(root: HTMLElement) {
    this.grid = root.querySelector("#grid")!;
    this.macroEl = root.querySelector("#macro")!;
    this.stripEl = root.querySelector("#project-strip")!;
    this.countEl = root.querySelector("#agent-count")!;
    this.btnLayout = root.querySelector("#btn-layout")!;
    this.btnGuard = root.querySelector("#btn-guard")!;
    this.btnNest = root.querySelector("#btn-nest")!;
    this.permSelect = root.querySelector("#perm-mode")!;
    this.resizeObs = new ResizeObserver(() => this.scheduleFit());

    root.querySelector("#btn-add")!.addEventListener("click", () => this.addAgentToActive());
    root.querySelector("#btn-fill")!.addEventListener("click", () => this.fill());
    root.querySelector("#btn-zoom")!.addEventListener("click", () => this.toggleZoom());
    root.querySelector("#btn-macro")!.addEventListener("click", () => this.toggleMacro());
    root.querySelector("#btn-open")!.addEventListener("click", () => this.openFolderProject());
    root.querySelector("#btn-clone")!.addEventListener("click", () => this.cloneProject());
    root.querySelector("#btn-guard")!.addEventListener("click", () => this.toggleGuardrails());
    root.querySelector("#btn-nest")!.addEventListener("click", () => this.toggleSubagentNest());
    root.querySelector("#btn-settings")!.addEventListener("click", () => this.openSettingsDialog());
    this.btnLayout.addEventListener("click", () => {
      this.layout = this.layout === "square" ? "fit" : "square";
      this.render();
    });
    this.permSelect.addEventListener("change", () => {
      this.permMode = this.permSelect.value as PermMode;
      this.persist();
    });

    window.addEventListener("keydown", (e) => this.onKey(e), true);
    window.addEventListener("resize", () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.render(), 120);
    });
  }

  async init() {
    this.shell = await defaultShell();
    this.home = await homeDir();
    this.saved = loadProjects();
    this.restore(); // start empty if nothing saved — the empty state guides setup
    this.render();
    window.setInterval(() => this.pollStats(), 2000);
    listen<Record<string, unknown>>("subagent", (e) => {
      if (this.subagentNest) handleSubagentEvent(e.payload, this.projects, () => this.render());
    });
  }

  /// Sample each agent's CPU% (process subtree) and live cwd; update badge and,
  /// display-only, follow `cd` in the path field + branch (no respawn).
  private async pollStats() {
    const items: { agent: Agent; pid: number }[] = [];
    for (const p of this.projects)
      for (const a of p.agents) {
        const pid = a.layers[0]?.pty?.pid;
        if (pid) items.push({ agent: a, pid });
      }
    if (!items.length) return;
    try {
      const stats = await agentStats(items.map((x) => x.pid));
      items.forEach((x, i) => {
        const s = stats[i];
        if (!s) return;
        x.agent.cpu = s.cpu;
        x.agent.cpuEl.textContent = `⚡${Math.round(s.cpu)}%`;
        // follow `cd` (display only) unless the user is editing the path field
        if (s.cwd && s.cwd !== x.agent.cwd && document.activeElement !== x.agent.pathEl) {
          x.agent.cwd = s.cwd;
          x.agent.pathEl.value = s.cwd;
          this.refreshBranch(x.agent);
        }
      });
    } catch {
      // sysinfo unavailable — skip this tick.
    }
  }

  private get curProject(): Project | undefined {
    return this.projects[this.ap];
  }
  private get agents(): Agent[] {
    return this.curProject?.agents ?? [];
  }

  // --- agent command (per-agent, configurable) -----------------------------

  /// Apply claude-specific permission flags only when the command is claude.
  private buildCmd(cmd: string): string {
    const base = cmd.trim() || "claude";
    if (base.startsWith("claude")) {
      if (this.permMode === "auto") return `${base} --permission-mode auto`;
      if (this.permMode === "bypass") return `${base} --dangerously-skip-permissions`;
    }
    return base;
  }
  /// Short label for a command's binary (e.g. "aider --model x" -> "aider").
  private agentLabel(cmd: string): string {
    const base = cmd.trim().split(/\s+/)[0] || "agent";
    return base.split("/").pop() || base;
  }
  private primaryLayer(cwd: string | null, cmd: string): Layer {
    return createTerminalLayer({
      title: this.agentLabel(cmd),
      shell: this.shell,
      args: ["-l", "-c", `${this.buildCmd(cmd)}; exec ${this.shell} -l`],
      cwd,
    });
  }
  private shellLayer(cwd: string | null): Layer {
    return createTerminalLayer({ title: "shell", shell: this.shell, args: ["-l"], cwd });
  }

  private fillAgentSelect(agent: Agent) {
    const sel = agent.agentSel;
    sel.replaceChildren();
    let matched = false;
    for (const p of this.agentPresets) {
      const o = document.createElement("option");
      o.value = p.cmd;
      o.textContent = p.label;
      if (p.cmd === agent.agentCmd) {
        o.selected = true;
        matched = true;
      }
      sel.appendChild(o);
    }
    if (!matched) {
      const o = document.createElement("option");
      o.value = agent.agentCmd;
      o.textContent = `⌥ ${this.agentLabel(agent.agentCmd)}`;
      o.selected = true;
      sel.appendChild(o);
    }
    const c = document.createElement("option");
    c.value = "__custom__";
    c.textContent = "custom…";
    sel.appendChild(c);
  }

  /// Switch the agent's CLI and respawn its primary layer in place.
  private setAgentCommand(agent: Agent, cmd: string) {
    agent.agentCmd = cmd;
    this.fillAgentSelect(agent);
    const old = agent.layers[0];
    const fresh = this.primaryLayer(agent.cwd, cmd);
    disposeLayer(old);
    agent.layers[0] = fresh;
    agent.active = 0;
    agent.stackEl.insertBefore(fresh.el, agent.stackEl.firstChild);
    this.observeLayer(fresh);
    this.render();
  }

  // --- agent lifecycle ------------------------------------------------------

  private newAgent(project: Project, cwd: string | null): Agent {
    const agent = createAgent(this.agentSeq++);
    agent.cwd = cwd;
    agent.agentCmd = this.agentCmd; // global default; per-agent override via the select
    agent.pathEl.value = cwd ?? "";
    this.fillAgentSelect(agent);
    project.agents.push(agent);

    const idx = () => project.agents.indexOf(agent);
    agent.cardEl.addEventListener("mousedown", () => {
      this.ap = this.projects.indexOf(project);
      this.focus(idx());
    });
    agent.cardEl.addEventListener("dblclick", () => {
      this.ap = this.projects.indexOf(project);
      this.focus(idx());
      this.toggleZoom();
    });
    agent.titleEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startTitleEdit(agent, () => this.render());
    });
    agent.closeEl.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.closeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeAgentObj(agent);
    });
    agent.pathEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") agent.pathEl.blur();
    });
    agent.pathEl.addEventListener("change", () => {
      const v = agent.pathEl.value.trim();
      if (v && v !== agent.cwd) this.setAgentCwd(agent, v);
    });
    agent.pickEl.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.pickEl.addEventListener("click", async (e) => {
      e.stopPropagation();
      const dir = await pickDirectory(agent.cwd ?? this.home);
      if (dir) this.setAgentCwd(agent, dir);
    });
    agent.agentSel.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.agentSel.addEventListener("change", async () => {
      const v = agent.agentSel.value;
      if (v === "__custom__") {
        const cmd = await askText({
          title: t("modal.customTitle"),
          placeholder: "aider --model gpt-5",
          value: agent.agentCmd,
        });
        if (!cmd) this.fillAgentSelect(agent); // revert dropdown
        else this.setAgentCommand(agent, cmd);
      } else {
        this.setAgentCommand(agent, v);
      }
    });
    return agent;
  }

  private async addAgentWithCwd(project: Project, cwd: string | null, focus = true) {
    const agent = this.newAgent(project, cwd);
    agent.title = cwd && cwd !== this.home ? basename(cwd) : `agent ${this.agentSeq - 1}`;
    if (this.guardrails || this.subagentNest) await this.applyAidtSettings(cwd);
    const layer = this.primaryLayer(cwd, agent.agentCmd);
    agent.layers.push(layer);
    this.observeLayer(layer);
    if (focus) {
      this.ap = this.projects.indexOf(project);
      this.focused = project.agents.length - 1;
    }
    this.render();
    this.refreshBranch(agent);
  }

  /// Look up and display the git branch of an agent's working directory.
  private async refreshBranch(agent: Agent) {
    if (!agent.cwd) return;
    try {
      const b = await currentBranch(agent.cwd);
      if (b !== agent.branch) {
        agent.branch = b;
        this.render();
      }
    } catch {
      // not a git dir — leave branch empty.
    }
  }

  private async addAgentToActive() {
    const p = this.curProject;
    if (!p) {
      toast(t("toast.noProject"), "error");
      return;
    }
    if (p.isGit) {
      const branch = `feature/${ymd()}-${p.agents.length + 1}`;
      try {
        const wt = await createWorktree(p.root, branch);
        await this.addAgentWithCwd(p, wt);
        toast(t("toast.worktree", branch));
      } catch (e) {
        toast(t("toast.worktreeFail", String(e)), "error");
      }
    } else {
      await this.addAgentWithCwd(p, p.root || this.home);
    }
  }

  private async fill() {
    const p = this.curProject;
    if (!p) return;
    while (p.agents.length < 9) {
      if (p.isGit) {
        const branch = `feature/${ymd()}-${p.agents.length + 1}`;
        try {
          const wt = await createWorktree(p.root, branch);
          await this.addAgentWithCwd(p, wt, false);
        } catch (e) {
          toast(t("toast.worktreeFail", String(e)), "error");
          break;
        }
      } else {
        await this.addAgentWithCwd(p, p.root || this.home, false);
      }
    }
    this.render();
  }

  // --- guardrails -----------------------------------------------------------

  /// Write our `.claude/settings.local.json` (deny-list + subagent hooks) into a
  /// cwd reflecting the current toggles. Skips the home dir (user's own config).
  /// When both toggles are off, the Rust side removes our file.
  private async applyAidtSettings(cwd: string | null) {
    if (!cwd || cwd === this.home) return;
    const deny = this.guardrails ? effectiveDeny(this.presets, this.customDeny) : [];
    try {
      await writeAidtSettings(cwd, deny, this.subagentNest);
    } catch (e) {
      toast(t("toast.guardFail", String(e)), "error");
    }
  }

  private async applyToAllCwds() {
    const dirs = new Set<string>();
    for (const p of this.projects) for (const a of p.agents) if (a.cwd) dirs.add(a.cwd);
    for (const d of dirs) await this.applyAidtSettings(d);
  }

  private async toggleGuardrails() {
    this.guardrails = !this.guardrails;
    await this.applyToAllCwds();
    toast(this.guardrails ? t("toast.guardOn") : t("toast.guardOff"));
    this.render();
  }

  private async toggleSubagentNest() {
    this.subagentNest = !this.subagentNest;
    if (!this.subagentNest) clearSubagentLayers(this.projects, () => this.render());
    await this.applyToAllCwds();
    toast(this.subagentNest ? t("toast.nestOn") : t("toast.nestOff"));
    this.render();
  }

  // --- per-agent cwd / title ------------------------------------------------

  private async setAgentCwd(agent: Agent, path: string) {
    agent.cwd = path;
    agent.pathEl.value = path;
    if (!agent.manualTitle) agent.title = basename(path);
    if (this.guardrails || this.subagentNest) await this.applyAidtSettings(path);
    const old = agent.layers[0];
    const fresh = this.primaryLayer(path, agent.agentCmd);
    disposeLayer(old);
    agent.layers[0] = fresh;
    agent.active = 0;
    agent.stackEl.insertBefore(fresh.el, agent.stackEl.firstChild);
    this.observeLayer(fresh);
    this.render();
    this.refreshBranch(agent);
  }

  private addLayerTo(agent: Agent | undefined, kind: "terminal" | "browser") {
    if (!agent) return;
    const layer =
      kind === "browser" ? createBrowserLayer("http://localhost:3000") : this.shellLayer(agent.cwd);
    agent.layers.push(layer);
    agent.active = agent.layers.length - 1;
    agent.stackEl.appendChild(layer.el);
    if (kind === "terminal") this.observeLayer(layer);
    this.render();
  }

  private closeLayerAt(agent: Agent | undefined, li: number) {
    if (!agent || agent.layers.length <= 1) return;
    const [removed] = agent.layers.splice(li, 1);
    disposeLayer(removed);
    agent.active = Math.min(agent.active, agent.layers.length - 1);
    this.render();
  }

  private closeAgentObj(agent: Agent | undefined) {
    if (!agent) return;
    for (const p of this.projects) {
      const i = p.agents.indexOf(agent);
      if (i < 0) continue;
      agent.layers.forEach(disposeLayer);
      p.agents.splice(i, 1);
      if (p === this.curProject) {
        this.focused = Math.max(0, Math.min(this.focused, p.agents.length - 1));
      }
      if (this.agents.length === 0) this.mode = "overview";
      this.render();
      return;
    }
  }

  private observeLayer(layer: Layer) {
    const host = layer.el.querySelector(".term-host");
    if (host) this.resizeObs.observe(host);
  }

  // --- project lifecycle ----------------------------------------------------

  private async openFolderProject() {
    let path: string | null;
    try {
      path = await pickDirectory(this.home);
    } catch {
      path = await askText({
        title: t("modal.openTitle"),
        placeholder: "/Users/you/dev/myrepo",
        value: this.home + "/",
      });
    }
    if (!path) return;
    const git = await isGitRepo(path);
    await this.openProject(basename(path) || path, path, git);
  }

  private async cloneProject() {
    const url = await askText({
      title: t("modal.cloneTitle"),
      placeholder: "https://github.com/user/repo.git",
    });
    if (!url) return;
    toast(t("toast.cloning", url));
    try {
      const path = await gitClone(url);
      await this.openProject(basename(path) || "repo", path, true);
      toast(t("toast.cloned", basename(path)));
    } catch (e) {
      toast(t("toast.cloneFail", String(e)), "error");
    }
  }

  /// Create + activate a project, record it as a saved bookmark, add first agent.
  private async openProject(label: string, path: string, isGit: boolean) {
    const p = createProject(label, path, isGit);
    this.projects.push(p);
    this.ap = this.projects.length - 1;
    this.focused = 0;
    this.view = "project";
    this.recordSaved(label, path, isGit);
    if (isGit) await this.addAgentToActive();
    else await this.addAgentWithCwd(p, path);
  }

  private recordSaved(label: string, path: string, isGit: boolean) {
    if (!this.saved.some((s) => s.path === path)) {
      this.saved.push({ label, path, isGit });
      saveProjects(this.saved);
    }
  }

  private openSavedProject(sp: SavedProject) {
    void this.openProject(sp.label, sp.path, sp.isGit);
  }

  private removeSavedProject(path: string) {
    this.saved = this.saved.filter((s) => s.path !== path);
    saveProjects(this.saved);
    this.render();
  }

  private async renameSavedProject(path: string) {
    const sp = this.saved.find((s) => s.path === path);
    if (!sp) return;
    const v = await askText({ title: t("saved.renameTitle"), value: sp.label });
    if (!v) return;
    sp.label = v;
    for (const p of this.projects) if (p.root === path) p.name = v;
    saveProjects(this.saved);
    this.render();
  }

  private switchProject(delta: number) {
    if (this.projects.length === 0) return;
    this.ap = (this.ap + delta + this.projects.length) % this.projects.length;
    this.focused = 0;
    this.view = "project";
    this.render();
  }

  private async openSettingsDialog() {
    const res = await openSettings({
      lang: getLang(),
      agentCmd: this.agentCmd,
      permMode: this.permMode,
      enabled: new Set(this.presets),
      customDeny: this.customDeny,
      agentPresets: this.agentPresets,
    });
    if (!res) return;
    if (res.lang !== getLang()) setLang(res.lang); // re-applies static labels
    this.agentCmd = res.agentCmd;
    this.permMode = res.permMode;
    this.presets = res.enabled;
    this.customDeny = res.customDeny;
    this.agentPresets = res.agentPresets.length ? res.agentPresets : [...DEFAULT_AGENT_PRESETS];
    for (const p of this.projects) for (const a of p.agents) this.fillAgentSelect(a);
    if (this.guardrails) {
      await this.applyToAllCwds(); // rewrite our files with the new deny-list
      toast(t("toast.settingsSavedGuard"));
    } else {
      toast(t("toast.settingsSaved"));
    }
    this.render();
  }

  // --- navigation -----------------------------------------------------------

  private focus(i: number) {
    if (i < 0 || i >= this.agents.length) return;
    this.focused = i;
    this.render();
  }
  private moveFocus(delta: number) {
    if (this.agents.length === 0) return;
    this.focus((this.focused + delta + this.agents.length) % this.agents.length);
  }
  private cycleDepth(delta: number) {
    const agent = this.agents[this.focused];
    if (!agent) return;
    agent.active = (agent.active + delta + agent.layers.length) % agent.layers.length;
    this.render();
  }
  private toggleZoom() {
    if (this.agents.length === 0) return;
    this.view = "project";
    this.mode = this.mode === "zoom" ? "overview" : "zoom";
    this.render();
  }
  private toggleMacro() {
    this.view = this.view === "macro" ? "project" : "macro";
    this.render();
  }

  // --- keyboard (leader = Alt/Option) --------------------------------------

  private onKey(e: KeyboardEvent) {
    if (!e.altKey) return;
    const handlers: Record<string, () => void> = {
      KeyT: () => this.addAgentToActive(),
      KeyL: () => this.moveFocus(1),
      ArrowRight: () => this.moveFocus(1),
      KeyH: () => this.moveFocus(-1),
      ArrowLeft: () => this.moveFocus(-1),
      KeyJ: () => this.cycleDepth(1),
      ArrowDown: () => this.cycleDepth(1),
      KeyK: () => this.cycleDepth(-1),
      ArrowUp: () => this.cycleDepth(-1),
      KeyZ: () => this.toggleZoom(),
      KeyN: () => this.addLayerTo(this.agents[this.focused], "terminal"),
      KeyB: () => this.addLayerTo(this.agents[this.focused], "browser"),
      KeyW: () => this.closeLayerAt(this.agents[this.focused], this.agents[this.focused]?.active ?? 0),
      KeyX: () => this.closeAgentObj(this.agents[this.focused]),
      KeyP: () => this.switchProject(1),
      KeyM: () => this.toggleMacro(),
    };
    let fn = handlers[e.code];
    if (!fn && /^Digit[1-9]$/.test(e.code)) {
      const n = parseInt(e.code.slice(5), 10) - 1;
      // Alt+1-9 focuses only — stays in overview. Use Alt+Z to zoom the focused one.
      fn = () => {
        this.view = "project";
        this.focus(n);
      };
    }
    if (fn) {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  }

  // --- render + persistence -------------------------------------------------

  render() {
    renderAll(this.ctx());
  }

  private ctx(): RenderCtx {
    return {
      grid: this.grid,
      macroEl: this.macroEl,
      stripEl: this.stripEl,
      countEl: this.countEl,
      btnLayout: this.btnLayout,
      btnGuard: this.btnGuard,
      btnNest: this.btnNest,
      permSelect: this.permSelect,
      projects: this.projects,
      ap: this.ap,
      focused: this.focused,
      mode: this.mode,
      view: this.view,
      layout: this.layout,
      permMode: this.permMode,
      guardrails: this.guardrails,
      subagentNest: this.subagentNest,
      saved: this.saved,
      openFolder: () => void this.openFolderProject(),
      clone: () => void this.cloneProject(),
      openSaved: (sp) => this.openSavedProject(sp),
      removeSaved: (path) => this.removeSavedProject(path),
      renameSaved: (path) => void this.renameSavedProject(path),
      selectProject: (i) => {
        this.ap = i;
        this.focused = 0;
        this.view = "project";
        this.render();
      },
      setLayer: (agent, li, ai) => {
        agent.active = li;
        this.focused = ai;
        this.render();
      },
      addLayer: (agent, kind, ai) => {
        this.focused = ai;
        this.addLayerTo(agent, kind);
      },
      closeLayer: (agent, li, ai) => {
        this.focused = ai;
        this.closeLayerAt(agent, li);
      },
      afterRender: () => {
        this.scheduleFit();
        this.persist();
      },
    };
  }

  private saveTimer: number | undefined;
  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      saveSnap(
        buildSnapshot(this.projects, {
          layout: this.layout,
          permMode: this.permMode,
          guardrails: this.guardrails,
          subagentNest: this.subagentNest,
          ap: this.ap,
          agentCmd: this.agentCmd,
          presets: [...this.presets],
          customDeny: this.customDeny,
          agentPresets: this.agentPresets,
        })
      );
    }, 400);
  }

  private restore(): boolean {
    const snap = loadSnap();
    if (!snap?.projects?.length) return false;
    this.layout = snap.layout === "fit" ? "fit" : "square";
    this.permMode = (["auto", "normal", "bypass"] as PermMode[]).includes(snap.permMode)
      ? snap.permMode
      : "auto";
    this.guardrails = !!snap.guardrails;
    this.subagentNest = !!snap.subagentNest;
    this.agentCmd = snap.agentCmd || "claude";
    this.customDeny = snap.customDeny ?? "";
    if (snap.presets) this.presets = new Set(snap.presets);
    if (snap.agentPresets?.length) this.agentPresets = snap.agentPresets;

    for (const ps of snap.projects) {
      const p = createProject(ps.name ?? "project", ps.root ?? "", !!ps.isGit);
      this.projects.push(p);
      for (const as of ps.agents ?? []) {
        const agent = this.newAgent(p, as.cwd ?? null);
        agent.title = as.title ?? agent.title;
        agent.manualTitle = !!as.manualTitle;
        agent.branch = as.branch ?? "";
        agent.agentCmd = as.agentCmd || this.agentCmd;
        this.fillAgentSelect(agent);
        this.refreshBranch(agent);
        for (let li = 0; li < (as.layers ?? []).length; li++) {
          const ls = as.layers[li];
          let layer: Layer;
          if (ls.kind === "browser") layer = createBrowserLayer(ls.url || "http://localhost:3000");
          else if (li === 0) layer = this.primaryLayer(as.cwd ?? null, agent.agentCmd);
          else layer = this.shellLayer(as.cwd ?? null);
          agent.layers.push(layer);
          agent.stackEl.appendChild(layer.el);
          if (layer.kind === "terminal") this.observeLayer(layer);
        }
        if (agent.layers.length === 0) {
          const l = this.primaryLayer(as.cwd ?? null, agent.agentCmd);
          agent.layers.push(l);
          agent.stackEl.appendChild(l.el);
          this.observeLayer(l);
        }
        agent.active = Math.min(Math.max(0, as.active ?? 0), agent.layers.length - 1);
      }
    }
    this.ap = Math.min(Math.max(0, snap.ap ?? 0), this.projects.length - 1);
    return true;
  }

  private fitPending = false;
  private scheduleFit() {
    if (this.fitPending) return;
    this.fitPending = true;
    requestAnimationFrame(() => {
      this.fitPending = false;
      if (this.view === "macro") return;
      this.agents.forEach((agent, ai) => {
        const visible = this.mode === "overview" || ai === this.focused;
        const front = agent.layers[agent.active];
        if (!visible || !front) return;
        const host = front.el.querySelector(".term-host") as HTMLElement | null;
        if (front.kind === "terminal" && host && host.clientWidth > 0) {
          if (!front.started && front.term) {
            startLayer(front, front.term.cols, front.term.rows)
              .then(() => fitLayer(front))
              .catch(() => front.term?.write(`\r\n\x1b[31m${t("spawn.fail")}\x1b[0m\r\n`));
          } else {
            fitLayer(front);
          }
        }
      });
      const f = this.agents[this.focused]?.layers[this.agents[this.focused].active];
      if (f?.term) f.term.focus();
    });
  }
}
