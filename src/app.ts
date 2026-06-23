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
import { Project } from "./project";
import { handleSubagentEvent, clearSubagentLayers } from "./subagent";
import { defaultShell, homeDir, agentStats } from "./pty";
import { createWorktree, writeAidtSettings, currentBranch } from "./git";
import { listen } from "@tauri-apps/api/event";
import { askText, toast, pickDirectory, openSettings, openSavesDialog, openHelp } from "./ui";
import { GUARD_PRESETS, effectiveDeny } from "./guard";
import { t, getLang, setLang } from "./i18n";
import { renderAll, RenderCtx, Mode, View, PermMode } from "./render";
import {
  buildSnapshot,
  saveSnap,
  loadSnap,
  loadProjects,
  restoreProjects,
  SavedProject,
  WorkspaceSnap,
  loadSaves,
  upsertSave,
  removeSave,
  getSave,
} from "./persistence";
import { ProjectsController } from "./projects-controller";

const ymd = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

const fmtMem = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)}G` : `${Math.round(bytes / 1e6)}M`;

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
  private projectsCtrl = new ProjectsController({
    projects: () => this.projects,
    saved: () => this.saved,
    home: () => this.home,
    activate: (p) => {
      this.ap = this.projects.indexOf(p);
      this.focused = 0;
      this.view = "project";
    },
    render: () => this.render(),
    addAgentToActive: () => this.addAgentToActive(),
    addAgentWithCwd: (project, cwd, focus) => this.addAgentWithCwd(project, cwd, focus),
  });

  private grid: HTMLElement;
  private macroEl: HTMLElement;
  private stripEl: HTMLElement;
  private countEl: HTMLElement;
  private btnLayout: HTMLElement;
  private btnGuard: HTMLElement;
  private btnNest: HTMLElement;
  private permSelect: HTMLSelectElement;
  private sendBar: HTMLElement;
  private sendInput: HTMLInputElement;
  private sendTarget: HTMLSelectElement;
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
    root.querySelector("#btn-run-all")!.addEventListener("click", () => this.launchAll());
    root.querySelector("#btn-zoom")!.addEventListener("click", () => this.toggleZoom());
    root.querySelector("#btn-macro")!.addEventListener("click", () => this.toggleMacro());
    root.querySelector("#btn-send")!.addEventListener("click", () => this.toggleSendBar());
    this.sendBar = root.querySelector("#sendbar")!;
    this.sendInput = root.querySelector("#send-input")!;
    this.sendTarget = root.querySelector("#send-target")!;
    root.querySelector("#send-go")!.addEventListener("click", () => this.doSend());
    this.sendInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.doSend();
      else if (e.key === "Escape") this.toggleSendBar(false);
    });
    root.querySelector("#btn-open")!.addEventListener("click", () => this.projectsCtrl.openFolderProject());
    root.querySelector("#btn-clone")!.addEventListener("click", () => this.projectsCtrl.cloneProject());
    root.querySelector("#btn-guard")!.addEventListener("click", () => this.toggleGuardrails());
    root.querySelector("#btn-nest")!.addEventListener("click", () => this.toggleSubagentNest());
    root.querySelector("#btn-saves")!.addEventListener("click", () => this.openSaves());
    root.querySelector("#btn-help")!.addEventListener("click", () => openHelp());
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
    // A terminal layer whose process exited (e.g. `exit`) auto-closes; the last
    // layer closing closes the window (tmux-style).
    listen<string>("pty-exit", (e) => this.onPtyExit(e.payload));
  }

  private onPtyExit(id: string) {
    for (const p of this.projects)
      for (const a of p.agents) {
        const li = a.layers.findIndex((l) => l.pty?.id === id);
        if (li < 0) continue;
        if (a.layers.length > 1) this.closeLayerAt(a, li);
        else this.closeAgentObj(a);
        return;
      }
  }

  /// Sample each agent's CPU% (process subtree) and live cwd; update badge and,
  /// display-only, follow `cd` in the path field + branch (no respawn).
  private async pollStats() {
    const items: { agent: Agent; pid: number }[] = [];
    const now = performance.now();
    for (const p of this.projects)
      for (const a of p.agents) {
        // Use a started terminal layer (prefer the active one) — the primary may
        // be unstarted if the user switched to a shell layer.
        const active = a.layers[a.active];
        const term =
          active?.kind === "terminal" && active.pty
            ? active
            : a.layers.find((l) => l.kind === "terminal" && l.pty);
        // "waiting": a launched agent whose terminal has been quiet for a bit
        // (settled at a prompt) — tint it amber so you can spot it.
        const quiet = !term?.lastOutput || now - term.lastOutput > 1500;
        a.cardEl.classList.toggle("waiting", !!a.running && !!term && quiet);
        const pid = term?.pty?.pid;
        if (pid) items.push({ agent: a, pid });
      }
    if (!items.length) return;
    try {
      const stats = await agentStats(items.map((x) => x.pid));
      items.forEach((x, i) => {
        const s = stats[i];
        if (!s) return;
        x.agent.cpu = s.cpu;
        x.agent.cpuEl.textContent = `⚡${Math.round(s.cpu)}% · ${fmtMem(s.mem)}`;
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
    let base = cmd.trim() || "claude";
    if (base.startsWith("claude")) {
      // Resume this directory's most recent conversation (starts fresh if none).
      // Each agent is its own worktree, so resume is naturally per-window.
      base += " --continue";
      if (this.permMode === "auto") base += " --permission-mode auto";
      else if (this.permMode === "bypass") base += " --dangerously-skip-permissions";
    }
    return base;
  }
  /// Short label for a command's binary (e.g. "aider --model x" -> "aider").
  private agentLabel(cmd: string): string {
    const base = cmd.trim().split(/\s+/)[0] || "agent";
    return base.split("/").pop() || base;
  }
  private primaryLayer(cwd: string | null, cmd: string, autoRun = true): Layer {
    // Interactive login shell (sources .zshrc → correct PATH), then type the
    // agent command — robust against "command not found" and leaves you at a
    // working shell when the agent exits.
    return createTerminalLayer({
      title: this.agentLabel(cmd),
      shell: this.shell,
      args: ["-l"],
      cwd,
      autoRun: autoRun ? this.buildCmd(cmd) : undefined,
      onOpenUrl: (url) => this.openUrl(url),
    });
  }

  /// Launch the agent's command in its front terminal on demand (▶). Used for
  /// restored / filled windows that come up as plain shells (avoids a startup
  /// stampede of many heavy claude processes).
  private launchAgent(agent: Agent) {
    const front = agent.layers[agent.active];
    const layer =
      front?.kind === "terminal" && front.pty
        ? front
        : agent.layers.find((l) => l.kind === "terminal" && l.pty);
    if (!layer?.pty) return;
    layer.pty.write(this.buildCmd(agent.agentCmd) + "\r");
    agent.running = true; // remember so a restore resumes this one
    this.persist();
  }

  /// Launch every not-yet-running window in the active project, each with its
  /// own selected agent (claude/codex/gemini/…). For machine-power users.
  private launchAll() {
    let n = 0;
    for (const a of this.agents) {
      if (!a.running) {
        this.launchAgent(a);
        n++;
      }
    }
    toast(t("toast.launchedAll", n));
  }
  private shellLayer(cwd: string | null): Layer {
    return createTerminalLayer({
      title: "shell",
      shell: this.shell,
      args: ["-l"],
      cwd,
      onOpenUrl: (url) => this.openUrl(url),
    });
  }

  /// Open a URL ⌘-clicked in a terminal as a new in-app browser layer on the
  /// focused agent (the one whose terminal was clicked), and bring it to front.
  private openUrl(url: string) {
    this.addLayerTo(this.agents[this.focused], "browser", url);
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
    agent.running = true;
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
    agent.runEl.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.runEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.launchAgent(agent);
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
    // Auto-run the agent only for a single focused add; bulk (fill, focus=false)
    // comes up as a shell to avoid launching many heavy claudes at once (▶ to run).
    agent.running = focus;
    const layer = this.primaryLayer(cwd, agent.agentCmd, focus);
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
    agent.running = true; // respawns and runs the agent in the new dir
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

  private addLayerTo(agent: Agent | undefined, kind: "terminal" | "browser", url?: string) {
    if (!agent) return;
    const layer =
      kind === "browser"
        ? createBrowserLayer(url ?? "http://localhost:3000")
        : this.shellLayer(agent.cwd);
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

  // --- project lifecycle (open/clone/saved bookmarks → projects-controller) --

  private switchProject(delta: number) {
    if (this.projects.length <= 1) {
      toast(t("toast.onlyOneProject"));
      return;
    }
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
    if (i < 0 || i >= this.agents.length || i === this.focused) return; // no re-render churn
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

  // --- cross-agent send (manual, tmux send-keys style) ----------------------

  private toggleSendBar(force?: boolean) {
    const show = force ?? this.sendBar.classList.contains("hidden");
    this.sendBar.classList.toggle("hidden", !show);
    if (show) setTimeout(() => this.sendInput.focus(), 0);
  }

  /// Inject a line into the terminal(s) of the chosen target (this / project /
  /// all). Manual only — autonomous agent-to-agent messaging is intentionally
  /// not built (loop/safety risk; use Claude Code's built-in subagents instead).
  private doSend() {
    const text = this.sendInput.value;
    if (!text.trim()) return;
    const target = this.sendTarget.value;
    const targets: Agent[] = [];
    if (target === "this") {
      const a = this.agents[this.focused];
      if (a) targets.push(a);
    } else if (target === "project") {
      targets.push(...this.agents);
    } else {
      for (const p of this.projects) targets.push(...p.agents);
    }
    let n = 0;
    for (const a of targets) {
      const active = a.layers[a.active];
      const layer =
        active?.kind === "terminal" && active.pty
          ? active
          : a.layers.find((l) => l.kind === "terminal" && l.pty);
      if (layer?.pty) {
        layer.pty.write(text + "\r");
        n++;
      }
    }
    this.sendInput.value = "";
    toast(t("toast.sent", n));
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
      Enter: () => this.toggleSendBar(),
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
      openFolder: () => void this.projectsCtrl.openFolderProject(),
      clone: () => void this.projectsCtrl.cloneProject(),
      openSaved: (sp) => this.projectsCtrl.openSavedProject(sp),
      removeSaved: (path) => this.projectsCtrl.removeSavedProject(path),
      renameSaved: (path) => void this.projectsCtrl.renameSavedProject(path),
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
  private snapshot(): WorkspaceSnap {
    return buildSnapshot(this.projects, {
      layout: this.layout,
      permMode: this.permMode,
      guardrails: this.guardrails,
      subagentNest: this.subagentNest,
      ap: this.ap,
      agentCmd: this.agentCmd,
      presets: [...this.presets],
      customDeny: this.customDeny,
      agentPresets: this.agentPresets,
    });
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => saveSnap(this.snapshot()), 400);
  }

  /// Apply a snapshot's settings + rebuild its projects into this app.
  private applySnapshot(snap: WorkspaceSnap) {
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

    this.ap = restoreProjects(snap, this.projects, this.agentCmd, {
      newAgent: (p, cwd) => this.newAgent(p, cwd),
      primaryLayer: (cwd, cmd, autoRun) => this.primaryLayer(cwd, cmd, autoRun), // resume only if was running
      shellLayer: (cwd) => this.shellLayer(cwd),
      createBrowserLayer,
      observeLayer: (l) => this.observeLayer(l),
      fillAgentSelect: (a) => this.fillAgentSelect(a),
      refreshBranch: (a) => void this.refreshBranch(a),
    });
  }

  private restore(): boolean {
    const snap = loadSnap();
    if (!snap?.projects?.length) return false;
    this.applySnapshot(snap);
    return true;
  }

  // --- named save slots (game-save style) ----------------------------------

  private openSaves() {
    openSavesDialog({
      list: () => loadSaves().map((s) => s.name),
      saveAs: (name) => {
        upsertSave(name, this.snapshot());
        toast(t("toast.saved", name));
      },
      load: (name) => this.loadSlot(name),
      remove: (name) => removeSave(name),
    });
  }

  private loadSlot(name: string) {
    const snap = getSave(name);
    if (!snap) return;
    for (const p of this.projects) for (const a of p.agents) a.layers.forEach(disposeLayer);
    this.projects.length = 0;
    this.grid.replaceChildren();
    this.focused = 0;
    this.view = "project";
    this.applySnapshot(snap);
    this.render();
    toast(t("toast.loaded", name));
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
