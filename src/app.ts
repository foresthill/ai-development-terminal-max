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
  sortByPriority,
  startTitleEdit,
  dbgLog,
  dbgOn,
  toggleDbg,
  dumpLayerBuffer,
  copyDebugLog,
  cycleRecomposite,
} from "./agent";
import { Project } from "./project";
import { createEditorLayer } from "./editor";
import { createCdpBrowserLayer } from "./browser-controller";
import { pickFile, pickSavePath, readFile, writeFile } from "./files";
import { checkForUpdates } from "./updater";
import { handleSubagentEvent, clearSubagentLayers } from "./subagent";
import { defaultShell, shellLoginArgs, homeDir, agentStats } from "./pty";
import { createWorktree, writeAidtSettings, currentBranch, gitRoot } from "./git";
import { claudeHasHistory, type MergedSession } from "./claude-sessions";
import { listen } from "@tauri-apps/api/event";
import { openPath, revealItemsInDir, openUrl as openExternalUrl } from "@tauri-apps/plugin-opener";
import {
  askText,
  toast,
  pickDirectory,
  openSettings,
  openSavesDialog,
  openHelp,
  confirmModal,
  openMenu,
  openColorMenu,
} from "./ui";
import { GUARD_PRESETS, effectiveDeny } from "./guard";
import { t, getLang, setLang } from "./i18n";
import { applyTheme, getThemeId, type ThemeId } from "./theme";
import { installAppMenu } from "./menu";
import { openMemoryPanel } from "./memory-panel";
import { openCommandPalette } from "./commands-palette";
import { openSkillsPanel } from "./skills-panel";
import { openFilesPanel } from "./files-panel";
import { sessionTag } from "./session";
import { memory, SHORT_TERM_TTL_MS } from "./memory";
import { applyWindowStyle, getWindowStyle } from "./window-style";
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

/// Show a cwd in the (left-aligned, ltr) path field so its TAIL — the current folder,
/// which is what matters since roots repeat — stays visible. The real path is kept on
/// dataset.full (focus restores it for editing); when it overflows, the value is
/// LEFT-elided to "…/<tail segments that fit>". No-ops safely before layout
/// (clientWidth 0) — the next stats tick re-fits it.
const fitPathTail = (el: HTMLInputElement, full: string): void => {
  el.dataset.full = full;
  el.value = full;
  if (!full || el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 1) return;
  const segs = full.split("/").filter(Boolean);
  for (let start = 1; start < segs.length; start++) {
    el.value = "…/" + segs.slice(start).join("/");
    if (el.scrollWidth <= el.clientWidth + 1) return;
  }
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
  private urlExternal = false; // false ⇒ clicked URLs open in the in-app browser
  private autoResume = false; // false ⇒ restored agents come up idle (click ▶ to run)
  private autoStart = true; // false ⇒ Alt+T opens an idle shell (click ▶ to launch the CLI)
  // Where ＋/Alt+T opens a new window: "focused" = the focused window's live dir (default,
  // so a new window spawns from where you are, not a clone of the top-left one), "root" =
  // repo root, "fixed" = newWindowPath. Configurable in Settings.
  private newWindowAnchor: "focused" | "root" | "fixed" = "focused";
  private newWindowPath = "";
  private shell = "/bin/zsh";
  private shellArgs: string[] = ["-l"]; // login-shell args per platform (set in init)
  private home = "";
  private agentSeq = 1;
  private resizeTimer: number | undefined;
  private refitTimer: number | undefined;
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
  private totalEl: HTMLElement;
  private btnLayout: HTMLElement;
  private btnGuard: HTMLElement;
  private btnNest: HTMLElement;
  private permSelect: HTMLSelectElement;
  private sendBar: HTMLElement;
  private sendInput: HTMLInputElement;
  private sendTarget: HTMLSelectElement;
  private resizeObs: ResizeObserver;

  constructor(root: HTMLElement) {
    applyTheme(getThemeId()); // restore the saved colour theme before first render
    applyWindowStyle(getWindowStyle()); // restore the saved window shape (rounded/angular)
    this.grid = root.querySelector("#grid")!;
    this.macroEl = root.querySelector("#macro")!;
    this.stripEl = root.querySelector("#project-strip")!;
    this.countEl = root.querySelector("#agent-count")!;
    this.totalEl = root.querySelector("#agent-total")!;
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
    root.querySelector("#foot-help")!.addEventListener("click", () => openHelp());
    root.querySelector("#btn-settings")!.addEventListener("click", () => this.openSettingsDialog());
    root.querySelector("#btn-memory")!.addEventListener("click", () => this.openMemoryDialog());
    root.querySelector("#btn-commands")!.addEventListener("click", () => this.openCommandDialog());
    root.querySelector("#btn-skills")!.addEventListener("click", () => this.openSkillsDialog());
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
    this.shellArgs = await shellLoginArgs();
    this.home = await homeDir();
    this.saved = loadProjects();
    await this.restore(); // start empty if nothing saved — the empty state guides setup
    this.render();
    window.setInterval(() => this.pollStats(), 2000);
    listen<Record<string, unknown>>("subagent", (e) => {
      if (this.subagentNest) handleSubagentEvent(e.payload, this.projects, () => this.render());
    });
    // A terminal layer whose process exited (e.g. `exit`) auto-closes; the last
    // layer closing closes the window (tmux-style).
    listen<string>("pty-exit", (e) => this.onPtyExit(e.payload));
    // Quiet auto-update check a few seconds after launch (shows a prompt only if an
    // update exists). Manual check is Alt+U. No-op until the updater key is set up.
    window.setTimeout(() => void checkForUpdates({ silent: true }), 4000);
    // Native menu bar: every toolbar action (plus language/theme/permission and the
    // update check) surfaced the macOS way. See menu.ts. No-op outside Tauri.
    void installAppMenu({ setTheme: (id) => this.setTheme(id) });
  }

  private onPtyExit(payload: string) {
    const [id, reason] = payload.split("|"); // reason: eof | err | channel
    dbgLog(`PTY-EXIT ${id} reason=${reason ?? "?"}`); // TEMP
    for (const p of this.projects)
      for (const a of p.agents) {
        const li = a.layers.findIndex((l) => l.pty?.id === id);
        if (li < 0) continue;
        if (a.layers.length > 1) this.closeLayerAt(a, li);
        else this.closeAgent(a); // shell exited (user typed `exit`) → close, no confirm
        return;
      }
  }

  /// Sample each agent's CPU% (process subtree) and live cwd; update badge and,
  /// display-only, follow `cd` in the path field + branch (no respawn).
  private async pollStats() {
    const items: { agent: Agent; pid: number; quiet: boolean }[] = [];
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
        const pid = term?.pty?.pid;
        // The amber "waiting" tint is finalized after we know each subtree's
        // process count (below) — agents with no live terminal are never amber.
        if (pid) {
          const quiet = !term?.lastOutput || now - term.lastOutput > 1500;
          items.push({ agent: a, pid, quiet });
        } else {
          a.cardEl.classList.remove("waiting");
        }
      }
    if (!items.length) {
      this.totalEl.textContent = "";
      return;
    }
    try {
      const stats = await agentStats(items.map((x) => x.pid));
      let sumCpu = 0;
      let sumMem = 0;
      let n = 0;
      items.forEach((x, i) => {
        const s = stats[i];
        if (!s) return;
        x.agent.cpu = s.cpu;
        x.agent.cpuEl.textContent = `⚡${Math.round(s.cpu)}% · ${fmtMem(s.mem)}`;
        sumCpu += s.cpu;
        sumMem += s.mem;
        n++;
        // "waiting" (amber): a launched agent settled quietly *with its command
        // still running* (subtree has more than the bare shell, procs > 1). Once
        // you exit claude back to an idle shell (procs == 1), the tint clears.
        const waiting = x.agent.running && x.quiet && s.procs > 1;
        x.agent.cardEl.classList.toggle("waiting", waiting);
        // Show where the shell has `cd`'d to — DISPLAY ONLY. We must NOT touch
        // agent.cwd (the user-set working dir, which is the spawn source for new
        // shell layers + restore, and the persisted value): overwriting it here made
        // new shells/restores spawn in a drifted dir, reverted the user's path edits,
        // and — once the user re-corrected the path — respawned the primary (claude)
        // layer, killing its session/venv. Surface the live dir as a tooltip + a
        // subtle "drift" marker on the path field when it differs from the set cwd.
        if (s.cwd) {
          x.agent.liveCwd = s.cwd;
          // Address bar follows the shell: show where it actually is now. DISPLAY
          // ONLY — we never touch agent.cwd (the spawn source for new shell layers +
          // restore) and we assign .value directly (no 'change' event), so this can
          // never respawn the agent. Skip while the user is editing the field.
          if (document.activeElement !== x.agent.pathEl) fitPathTail(x.agent.pathEl, s.cwd);
          const drift = !!x.agent.cwd && s.cwd !== x.agent.cwd;
          x.agent.pathEl.classList.toggle("drift", drift);
          // When the live dir differs, the field shows the live dir; the tooltip
          // names the set/spawn dir so it's clear where new shells will start.
          x.agent.pathEl.title = drift ? t("agent.setDir", x.agent.cwd!) : "";
        }
      });
      // Running total across every live agent (all projects). CPU% is summed
      // across cores, so it can exceed 100%.
      this.totalEl.textContent = n ? `Σ ⚡${Math.round(sumCpu)}% · ${fmtMem(sumMem)}` : "";
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

  /// Apply claude-specific flags only when the command is claude. `--continue`
  /// (resume) is added only when `resume` is true — the caller passes false for a
  /// directory with no prior conversation, so a fresh dir doesn't print the noisy
  /// "No conversation found to continue". Permission mode is independent of resume.
  private buildCmd(cmd: string, resume = true): string {
    let base = cmd.trim() || "claude";
    if (base.startsWith("claude")) {
      // Don't add --continue if the command already resumes/continues (e.g. the orca
      // "open in worktree" launch is `claude --resume <id>`): two resume flags conflict.
      const alreadyResumes = /(^|\s)(--continue|-c|--resume|-r)(\s|$)/.test(base);
      if (resume && !alreadyResumes) base += " --continue";
      if (this.permMode === "auto") base += " --permission-mode auto";
      else if (this.permMode === "bypass") base += " --dangerously-skip-permissions";
    }
    return base;
  }

  /// Whether launching claude in `cwd` should resume (--continue): only for a claude
  /// command, and only when that directory already has a conversation on disk. Any
  /// error (or non-Tauri context) → false, i.e. start clean.
  private async claudeResume(cwd: string | null, cmd: string): Promise<boolean> {
    if (!cwd || !(cmd.trim() || "claude").startsWith("claude")) return false;
    return claudeHasHistory(cwd);
  }
  /// Short label for a command's binary (e.g. "aider --model x" -> "aider").
  private agentLabel(cmd: string): string {
    const base = cmd.trim().split(/\s+/)[0] || "agent";
    return base.split("/").pop() || base;
  }
  private primaryLayer(cwd: string | null, cmd: string, autoRun = true, resume = true): Layer {
    // Interactive login shell (sources .zshrc → correct PATH), then type the
    // agent command — robust against "command not found" and leaves you at a
    // working shell when the agent exits.
    return createTerminalLayer({
      title: this.agentLabel(cmd),
      shell: this.shell,
      args: this.shellArgs,
      cwd,
      autoRun: autoRun ? this.buildCmd(cmd, resume) : undefined,
      onOpenUrl: (url, mod) => this.openUrl(url, mod),
      onOpenPath: (raw, cwd, mode) => this.openPathLink(raw, cwd, mode),
    });
  }

  /// Launch the agent's command on demand (▶). Always targets the agent's PRIMARY
  /// terminal (the first terminal layer = layer 0), never whichever layer happens
  /// to be front — so pressing ▶ while a secondary shell layer is focused can't
  /// start a second claude there (the "claude running in both the claude and shell
  /// windows" duplicate). Re-pressing ▶ just lands in the same primary layer.
  private async launchAgent(agent: Agent) {
    const layer = agent.layers.find((l) => l.kind === "terminal" && l.pty);
    if (!layer?.pty) return;
    const resume = await this.claudeResume(agent.cwd, agent.agentCmd);
    layer.pty.write(this.buildCmd(agent.agentCmd, resume) + "\r");
    agent.running = true; // remember so a restore resumes this one
    this.remember(`▶ ${agent.agentCmd}`, agent);
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
      args: this.shellArgs,
      cwd,
      onOpenUrl: (url, mod) => this.openUrl(url, mod),
      onOpenPath: (raw, cwd2, mode) => this.openPathLink(raw, cwd2, mode),
    });
  }

  /// Open a URL clicked in a terminal. Default target is the Settings choice
  /// (in-app browser layer, or the OS browser); holding ⌘/Ctrl while clicking
  /// opens the OTHER target. So with the default (in-app): plain click → in-app,
  /// ⌘/Ctrl-click → external.
  private openUrl(url: string, modifierHeld = false) {
    const external = modifierHeld ? !this.urlExternal : this.urlExternal;
    if (external) void openExternalUrl(url);
    else this.addLayerTo(this.agents[this.focused], "browser", url);
  }

  /// Open a file path clicked in a terminal. Alt/Option-click opens it in the built-in
  /// editor (fast, in-app); ⌘/Ctrl-click opens the path with the OS default app; adding
  /// Shift reveals it in its CONTAINING folder instead (Finder/Explorer, item selected).
  /// Resolves `~` and relative paths against the terminal's cwd; strips any `:line` tail.
  private async openPathLink(raw: string, cwd: string | null, mode: "open" | "reveal" | "edit" = "open") {
    let p = raw.replace(/:\d+(?:[:.]\d+)?$/, ""); // drop :line[:col]
    if (p.startsWith("~/")) p = this.home + p.slice(1);
    else if (!p.startsWith("/")) p = (cwd ?? this.home).replace(/\/$/, "") + "/" + p.replace(/^\.\//, "");
    try {
      if (mode === "edit") {
        this.addEditorLayer(this.agents[this.focused], p);
        toast(t("toast.editingPath", p));
      } else if (mode === "reveal") {
        await revealItemsInDir(p);
        toast(t("toast.revealedPath", p));
      } else {
        await openPath(p);
        // Surface where the (often relative) path actually resolved to — a relative
        // path claude prints is otherwise hard to locate without digging.
        toast(t("toast.openedPath", p));
      }
    } catch {
      toast(t("toast.openPathFail", p));
    }
  }

  /// Reveal the agent's working directory in Finder (the 📂 button — `open .`).
  private async openCwdInFinder(agent: Agent) {
    if (!agent.cwd) {
      toast(t("toast.noDir"), "error");
      return;
    }
    try {
      await openPath(agent.cwd);
    } catch {
      toast(t("toast.openPathFail", agent.cwd));
    }
  }

  /// Reflect the agent's current CLI on the ▾ caret (tooltip) and only show the
  /// caret when there's a real choice (2+ presets) — with one preset the row is
  /// just ▶. The actual chooser is the popup opened on click (openAgentMenu).
  private fillAgentSelect(agent: Agent) {
    agent.agentSel.title = `${t("tip.agentSel")} — ${this.agentLabel(agent.agentCmd)}`;
    agent.agentSel.style.display = this.agentPresets.length >= 2 ? "" : "none";
  }

  /// Popup CLI chooser for one agent (the ▾ caret): the presets plus "custom…".
  private openAgentMenu(agent: Agent) {
    const items = this.agentPresets.map((p) => ({ label: p.label, value: p.cmd }));
    items.push({ label: t("set.custom"), value: "__custom__" });
    openMenu(agent.agentSel, items, agent.agentCmd, async (v) => {
      if (v === "__custom__") {
        const cmd = await askText({
          title: t("modal.customTitle"),
          placeholder: "aider --model gpt-5",
          value: agent.agentCmd,
        });
        if (cmd) this.setAgentCommand(agent, cmd);
      } else {
        this.setAgentCommand(agent, v);
      }
    });
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
    fitPathTail(agent.pathEl, cwd ?? "");
    this.fillAgentSelect(agent);
    project.agents.push(agent);

    const idx = () => project.agents.indexOf(agent);
    agent.cardEl.addEventListener("mousedown", () => {
      this.ap = this.projects.indexOf(project);
      this.focus(idx());
    });
    // Keyboard focus is the source of truth. A click into a terminal focuses xterm's
    // own textarea directly, which may NOT update `this.focused`; then the next render
    // calls term.focus() on the (stale) focused agent and yanks DOM focus back there,
    // so keystrokes land in the wrong agent — the "typed into vim but it went to the
    // claude window" bug (confirmed: keys reached vim, then focus bounced to a 47x11
    // claude pane). Syncing this.focused to whatever card actually holds focus keeps
    // focus from being stolen back. focus() early-returns when the index is unchanged,
    // so the programmatic term.focus() in render() can't loop here.
    agent.cardEl.addEventListener("focusin", () => {
      this.ap = this.projects.indexOf(project);
      this.focus(idx());
    });
    // Double-click to zoom — handy on the terminal and the header, so it lives on
    // the whole card. EXCEPT inside the in-app browser (URL bar / page), where a
    // double-click is for selecting text or interacting, not zooming.
    agent.cardEl.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".layer-browser")) return;
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
    agent.pathEl.addEventListener("dblclick", (e) => e.stopPropagation()); // don't zoom
    agent.pathEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") agent.pathEl.blur();
    });
    agent.pathEl.addEventListener("change", () => {
      const v = agent.pathEl.value.trim();
      if (v && v !== agent.cwd) this.setAgentCwd(agent, v);
    });
    // Editing needs the REAL path, not the elided "…/tail": restore it on focus, and
    // re-elide on blur. ('change' fires before 'blur' when the value changed, so a
    // committed edit still reaches setAgentCwd with the typed path.)
    agent.pathEl.addEventListener("focus", () => {
      if (agent.pathEl.dataset.full) agent.pathEl.value = agent.pathEl.dataset.full;
    });
    agent.pathEl.addEventListener("blur", () => {
      fitPathTail(agent.pathEl, agent.pathEl.dataset.full ?? agent.pathEl.value);
    });
    agent.pickEl.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.pickEl.addEventListener("click", async (e) => {
      e.stopPropagation();
      const dir = await pickDirectory(agent.cwd ?? this.home);
      if (dir) this.setAgentCwd(agent, dir);
    });
    agent.openDirEl.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.openDirEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openCwdInFinder(agent);
    });
    agent.agentSel.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.agentSel.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openAgentMenu(agent);
    });
    agent.prioEl.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.prioEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cyclePriority(agent);
    });
    agent.colorEl.addEventListener("mousedown", (e) => e.stopPropagation());
    agent.colorEl.addEventListener("click", (e) => {
      e.stopPropagation();
      openColorMenu(agent.colorEl, agent.color, (c) => {
        agent.color = c;
        this.render();
      });
    });
    return agent;
  }

  /// Cycle a window's priority none→low→mid→high→none. Higher priority makes the
  /// window bigger + brighter AND floats it to the front of the overview (see
  /// arrangeByPriority + render + styles). render()'s afterRender persists and
  /// re-fits, so the size/position change re-fits its terminal.
  private cyclePriority(agent: Agent) {
    agent.priority = (agent.priority + 1) % 4;
    this.arrangeByPriority();
    this.render();
  }

  /// Re-order the active project's windows by priority (higher first) so the
  /// most important ones sit top-left in the overview. `focused` follows its own
  /// window across the move, so the focus ring and Alt+1-9 stay meaningful. With
  /// no priorities set the sort is a no-op (stable), so order is untouched.
  private arrangeByPriority() {
    const agents = this.curProject?.agents;
    if (!agents || agents.length < 2) return;
    const cur = agents[this.focused];
    sortByPriority(agents);
    if (cur) this.focused = Math.max(0, agents.indexOf(cur));
  }

  private async addAgentWithCwd(project: Project, cwd: string | null, focus = true, launchCmd?: string) {
    const agent = this.newAgent(project, cwd);
    if (launchCmd) agent.agentCmd = launchCmd; // e.g. orca "open in worktree": claude --resume <id>
    agent.title = cwd && cwd !== this.home ? basename(cwd) : `agent ${this.agentSeq - 1}`;
    if (this.guardrails || this.subagentNest) await this.applyAidtSettings(cwd);
    // Auto-run the agent only for a single focused add, and only when auto-start
    // is on (Settings). Bulk (fill, focus=false) always comes up as a shell to
    // avoid launching many heavy claudes at once; with auto-start off, even a
    // focused Alt+T opens an idle shell (▶ / Alt+R to launch). An explicit launchCmd
    // (orca resume) always runs — the user asked for it by name.
    const autoRun = launchCmd ? true : focus && this.autoStart;
    agent.running = autoRun;
    // Resume (--continue) only when auto-launching into a dir that already has a
    // conversation — a fresh dir starts clean (no "No conversation found"). A launchCmd
    // carries its own resume (--resume <id>), so buildCmd must not add --continue.
    const resume = launchCmd ? false : autoRun ? await this.claudeResume(cwd, agent.agentCmd) : true;
    const layer = this.primaryLayer(cwd, agent.agentCmd, autoRun, resume);
    agent.layers.push(layer);
    this.observeLayer(layer);
    if (focus) {
      this.ap = this.projects.indexOf(project);
      this.focused = project.agents.length - 1;
    }
    this.render();
    if (focus) this.remember(`+ ${agent.title}`, agent); // short-term: new agent
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

  /// Add a plain window (Alt+T / ＋). Opens at the repo root (or home) — it does NOT
  /// create a git worktree. Surprise worktrees-on-add broke claude --continue
  /// continuity and confused the folder you land in; a worktree is now a deliberate
  /// choice via addWorktreeAgent (Alt+Shift+T), not a side effect of adding a window.
  private async addAgentToActive() {
    const p = this.curProject;
    if (!p) {
      toast(t("toast.noProject"), "error");
      return;
    }
    await this.addAgentWithCwd(p, this.newWindowCwd(p));
  }

  /// Where a new ＋/Alt+T window opens, per the Settings "new window" anchor:
  /// "focused" → the focused window's live dir (spawn from where you are), "fixed" →
  /// the configured path, else the repo root. Always falls back to the repo root/home.
  private newWindowCwd(p: Project): string {
    if (this.newWindowAnchor === "fixed" && this.newWindowPath.trim()) {
      return this.newWindowPath.trim();
    }
    if (this.newWindowAnchor === "focused") {
      const f = this.agents[this.focused];
      const dir = f?.liveCwd || f?.cwd;
      if (dir) return dir;
    }
    return p.root || this.home;
  }

  /// Deliberately create a NEW git worktree (isolated branch feature/<ymd>-N) and open
  /// an agent in it — the opt-in counterpart to addAgentToActive (Alt+Shift+T). On a
  /// non-git project it just adds a plain window.
  private async addWorktreeAgent() {
    const p = this.curProject;
    if (!p) {
      toast(t("toast.noProject"), "error");
      return;
    }
    if (!p.isGit) {
      await this.addAgentWithCwd(p, p.root || this.home);
      return;
    }
    const branch = `feature/${ymd()}-${p.agents.length + 1}`;
    try {
      const wt = await createWorktree(p.root, branch);
      await this.addAgentWithCwd(p, wt);
      toast(t("toast.worktree", branch));
    } catch (e) {
      toast(t("toast.worktreeFail", String(e)), "error");
    }
  }

  /// orca workflow: from the Claude-session list (Alt+G), open a chosen past
  /// conversation in its OWN new git worktree and resume it there. A worktree of the
  /// session's repo is searched first by `claude --resume <id>`, so the exact
  /// conversation resumes in place (verified against code.claude.com/docs/en/sessions:
  /// the ID is found in "the current project directory and its git worktrees" first).
  /// Intent → isolated worktree → that conversation, in one click.
  private async openSessionInWorktree(s: MergedSession) {
    const root = await gitRoot(s.cwd).catch(() => "");
    if (!root) {
      toast(t("sess.notRepo"), "error");
      return;
    }
    // Reuse the open project for this repo, or open it (adds a root agent) so the
    // worktree agent has a home. Dedupe by root — openProject itself does not.
    let project = this.projects.find((p) => p.root === root);
    if (!project) {
      await this.projectsCtrl.openProject(basename(root) || root, root, true);
      project = this.projects.find((p) => p.root === root);
    }
    if (!project) {
      toast(t("toast.noProject"), "error");
      return;
    }
    const branch = `feature/${ymd()}-${project.agents.length + 1}`;
    try {
      const wt = await createWorktree(root, branch);
      await this.addAgentWithCwd(project, wt, true, `claude --resume ${s.sessionId}`);
      toast(t("toast.worktree", branch));
    } catch (e) {
      toast(t("toast.worktreeFail", String(e)), "error");
    }
  }

  private async fill() {
    const p = this.curProject;
    if (!p) return;
    // Fill with plain windows at the repo root — no worktrees (see addAgentToActive).
    while (p.agents.length < 9) {
      await this.addAgentWithCwd(p, p.root || this.home, false);
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
    fitPathTail(agent.pathEl, path);
    agent.running = false; // navigation, not launch — a plain shell; ▶ runs the agent
    if (!agent.manualTitle) agent.title = basename(path);
    if (this.guardrails || this.subagentNest) await this.applyAidtSettings(path);
    // Changing the path is NAVIGATION, not a launch: open a plain shell at the new dir.
    // It must not auto-start claude — that surprised people, and resuming the dir's
    // "most recent" conversation is ambiguous (you can't tell which session). Press ▶
    // (or pick a session from Alt+G) to run the agent here.
    const old = agent.layers[0];
    const fresh = this.shellLayer(path);
    disposeLayer(old);
    agent.layers[0] = fresh;
    agent.active = 0;
    agent.stackEl.insertBefore(fresh.el, agent.stackEl.firstChild);
    this.observeLayer(fresh);
    this.render();
    this.refreshBranch(agent);
  }

  private addLayerTo(agent: Agent | undefined, kind: "terminal" | "browser" | "editor", url?: string) {
    if (!agent) return;
    if (kind === "editor") return void this.addEditorLayer(agent);
    const layer =
      kind === "browser"
        ? createBrowserLayer(url ?? "http://localhost:3000", (u) => void openExternalUrl(u))
        : this.shellLayer(agent.liveCwd || agent.cwd); // new shell opens where you are (after cd)
    agent.layers.push(layer);
    agent.active = agent.layers.length - 1;
    agent.stackEl.appendChild(layer.el);
    if (kind === "terminal") this.observeLayer(layer);
    this.render();
  }

  /// Add an editor layer. With an explicit `path` (e.g. Alt-click on a terminal path) the
  /// file opens straight away; without one it starts an UNTITLED buffer (no picker) — use
  /// the toolbar's Open to load a file and Save to write it. A fast, in-app alternative to
  /// launching a heavyweight external editor.
  private addEditorLayer(agent: Agent | undefined, path?: string) {
    if (!agent) return;
    // Start the Open/Save pickers where the shell actually is (after a `cd`), falling back
    // to the agent's set dir — so opening a file lands "here", not the original folder.
    const startDir = agent.liveCwd || agent.cwd || undefined;
    const layer = createEditorLayer(path ?? null, startDir);
    agent.layers.push(layer);
    agent.active = agent.layers.length - 1;
    agent.stackEl.appendChild(layer.el);
    this.render();
    layer.editorView?.focus();
  }

  /// Add a CDP browser layer (方式A/C1, Alt+Shift+B): launches the user's own Chrome for
  /// a URL in its own window and shows an in-app control/inspector panel wired over CDP.
  /// Heavy logic lives in browser-controller.ts; this is just the layer-lifecycle wiring.
  private addCdpBrowserLayer(agent: Agent | undefined) {
    if (!agent) return;
    const layer = createCdpBrowserLayer("https://example.com");
    agent.layers.push(layer);
    agent.active = agent.layers.length - 1;
    agent.stackEl.appendChild(layer.el);
    this.render();
  }

  private closeLayerAt(agent: Agent | undefined, li: number) {
    if (!agent || agent.layers.length <= 1) return;
    const [removed] = agent.layers.splice(li, 1);
    disposeLayer(removed);
    agent.active = Math.min(agent.active, agent.layers.length - 1);
    this.render();
  }

  /// Reset the front terminal layer: kill its PTY and spawn a fresh shell in the
  /// same cwd, in place. The recovery hatch for a stuck/blank terminal — a
  /// full-screen app (vim) that didn't repaint, or a prompt looping on a cursor
  /// report. Resetting the primary layer drops it to an idle shell (running =
  /// false), so ▶ / Alt+R re-launches the agent (claude resumes via --continue).
  private resetFrontTerminal(agent: Agent | undefined) {
    if (!agent) return;
    const li = agent.active;
    const old = agent.layers[li];
    if (!old || old.kind !== "terminal") {
      toast(t("toast.resetNonTerm"), "error");
      return;
    }
    const fresh = this.shellLayer(agent.liveCwd || agent.cwd); // reset where you are (after cd)
    disposeLayer(old);
    agent.layers[li] = fresh;
    agent.stackEl.appendChild(fresh.el);
    if (li === 0) agent.running = false; // primary → idle shell; ▶ / Alt+R relaunches
    this.observeLayer(fresh);
    this.render();
    toast(t("toast.reset"));
  }

  /// Remove the agent and its window immediately, no prompt. Used when the shell
  /// exited on its own — the user typed `exit`, which is already an explicit
  /// request to close, so nagging with a confirm would be wrong (this is the
  /// tmux-style "last pane closes the window" path from onPtyExit).
  private closeAgent(agent: Agent | undefined) {
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

  /// Confirm, then close. Used by the MANUAL close paths (Alt+X, the ✕ button),
  /// which are easy to hit by accident (Alt+X sits next to nano's Ctrl+X), so a
  /// stray keystroke can't nuke a running agent.
  private async closeAgentObj(agent: Agent | undefined) {
    if (!agent) return;
    const ok = await confirmModal({
      title: t("confirm.closeAgent.title"),
      body: t("confirm.closeAgent.body", agent.title),
      confirm: t("confirm.closeAgent.ok"),
      danger: true,
    });
    if (!ok) return;
    this.closeAgent(agent);
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

  /// Apply a colour theme (persists + swaps CSS tokens) and repaint every open
  /// terminal with the new palette. Shared by the Settings dialog and the View ▸
  /// Theme menu so both behave identically.
  private setTheme(id: ThemeId) {
    const tt = applyTheme(id);
    for (const p of this.projects)
      for (const a of p.agents) for (const l of a.layers) if (l.term) l.term.options.theme = tt;
  }

  private async openSettingsDialog() {
    const res = await openSettings({
      lang: getLang(),
      theme: getThemeId(),
      windowStyle: getWindowStyle(),
      agentCmd: this.agentCmd,
      permMode: this.permMode,
      enabled: new Set(this.presets),
      customDeny: this.customDeny,
      agentPresets: this.agentPresets,
      urlExternal: this.urlExternal,
      autoResume: this.autoResume,
      autoStart: this.autoStart,
      newWindowAnchor: this.newWindowAnchor,
      newWindowPath: this.newWindowPath,
    }, () => void checkForUpdates({ silent: false }));
    if (!res) return;
    if (res.lang !== getLang()) setLang(res.lang); // re-applies static labels
    if (res.windowStyle !== getWindowStyle()) applyWindowStyle(res.windowStyle);
    if (res.theme !== getThemeId()) this.setTheme(res.theme);
    this.agentCmd = res.agentCmd;
    this.permMode = res.permMode;
    this.presets = res.enabled;
    this.customDeny = res.customDeny;
    this.urlExternal = res.urlExternal;
    this.autoResume = res.autoResume;
    this.autoStart = res.autoStart;
    this.newWindowAnchor = res.newWindowAnchor;
    this.newWindowPath = res.newWindowPath;
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
    // Defensive second fit after the layout settles. render()'s fit runs in an
    // immediate rAF, which can race the grid relayout (and xterm's renderer) on a
    // zoom transition; a settled re-fit (same timing as the window-resize path)
    // makes the terminal match its final cell size.
    this.refitSoon();
  }
  private toggleMacro() {
    this.view = this.view === "macro" ? "project" : "macro";
    this.render();
    this.refitSoon();
  }

  /// Re-run fit once the layout has settled (mirrors the debounced window-resize
  /// path). Used after zoom/macro toggles, where an immediate fit can measure a
  /// terminal mid-transition.
  private refitSoon() {
    clearTimeout(this.refitTimer);
    this.refitTimer = window.setTimeout(() => this.scheduleFit(), 130);
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

  // --- project memory (phase 1: personal unconscious) -----------------------

  /// Open the Claude-session overview — the automatic long-term memory (see
  /// claude-sessions.ts / the 2026-11-10 design doc). Global by default (every session
  /// across all projects); if a project is focused it also offers a "this project"
  /// filter. Resume into an agent is human-driven (types, never auto-submits).
  private openMemoryDialog() {
    const p = this.curProject;
    openMemoryPanel({
      projectId: p?.root ?? null,
      projectLabel: p?.name ?? null,
      sendToAgent: (text) => this.typeIntoFocusedAgent(text),
      openInWorktree: (s) => void this.openSessionInWorktree(s),
    });
  }

  /// Auto-sediment: passively record a lightweight activity note into the current
  /// project's SHORT-TERM (conscious) memory. Recording only — never injects. These
  /// expire (SHORT_TERM_TTL_MS) so short-term stays recent; the human promotes any
  /// worth keeping to long-term in the panel. Best-effort (memory failures ignored).
  private remember(title: string, agent?: Agent) {
    const p = this.curProject;
    if (!p || !p.root) return;
    try {
      memory.write({
        scope: "conscious",
        projectId: p.root,
        agentId: agent?.id ?? null,
        kind: "note",
        title,
        body: agent?.branch ? `branch: ${agent.branch}` : "",
        tags: [sessionTag()], // stamp the launch so short-term groups by session
        ttlMs: SHORT_TERM_TTL_MS,
      });
    } catch {
      /* memory is best-effort */
    }
  }

  /// Claude Code command palette (Alt+C): the 15 slash commands, one click types the
  /// chosen one into the focused agent (human submits). See commands-palette.ts.
  private openCommandDialog() {
    openCommandPalette({ sendToAgent: (text) => this.typeIntoFocusedAgent(text) });
  }

  /// Claude Code skills browser (Alt+S): the filesystem-scanned list of skills
  /// (project .claude/skills + user ~/.claude/skills + plugins), one click TYPES the
  /// chosen one's slash form into the focused agent (human submits). See skills-panel.ts.
  private openSkillsDialog() {
    openSkillsPanel({
      projectCwd: this.curProject?.root ?? null,
      sendToAgent: (text) => this.typeIntoFocusedAgent(text),
    });
  }

  /// Browse the focused agent's working directory (Alt+O) and open a file in the editor —
  /// a quick way to reach files the app or a Claude agent just created (e.g. generated .md).
  private openFilesDialog() {
    const a = this.agents[this.focused];
    openFilesPanel({
      cwd: a?.liveCwd || a?.cwd || this.home,
      home: this.home,
      openInEditor: (path) => this.addEditorLayer(this.agents[this.focused], path),
    });
  }

  /// Type text into the focused agent's terminal WITHOUT submitting (no CR), so the
  /// person reviews and sends it. Returns false when there's no terminal to type to.
  private typeIntoFocusedAgent(text: string): boolean {
    const a = this.agents[this.focused];
    if (!a) return false;
    const active = a.layers[a.active];
    const layer =
      active?.kind === "terminal" && active.pty
        ? active
        : a.layers.find((l) => l.kind === "terminal" && l.pty);
    if (!layer?.pty) return false;
    layer.pty.write(text);
    return true;
  }

  // --- keyboard (leader = Alt/Option) --------------------------------------

  private onKey(e: KeyboardEvent) {
    if (dbgOn()) {
      const ae = document.activeElement as HTMLElement | null;
      dbgLog(`win:'${e.key}' focus=${ae?.className || ae?.tagName || "?"}`);
    } // TEMP
    if (!e.altKey) return;
    // Alt+Shift+C: copy the persisted diagnostic logs to the clipboard so the whole
    // trace pastes in one go (vim diagnostic). Handled before the map so plain
    // Alt+C still reaches the terminal untouched. TEMP.
    if (e.shiftKey && e.code === "KeyC") {
      e.preventDefault();
      e.stopPropagation();
      void copyDebugLog().then((s) => toast(`log: ${s}`));
      return;
    }
    // Alt+Shift+V: cycle the vim compositing TEST BENCH strategy (TEMP). Open vim in a
    // RELEASE build and press this until the alt-screen paints; report the index.
    if (e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      e.stopPropagation();
      toast(`recomposite: ${cycleRecomposite()}`);
      return;
    }
    const handlers: Record<string, () => void> = {
      // Alt+T: plain window. Alt+Shift+T: deliberately create a git worktree.
      KeyT: () => (e.shiftKey ? this.addWorktreeAgent() : this.addAgentToActive()),
      // Focus/depth on H/J/K/L and the arrows. (Trade-off: Alt+arrow is the app
      // shortcut, so it doesn't reach the terminal — use Ctrl+arrow / Esc+f/b for
      // word nav in claude/shell.)
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
      KeyB: () =>
        e.shiftKey
          ? this.addCdpBrowserLayer(this.agents[this.focused])
          : this.addLayerTo(this.agents[this.focused], "browser"),
      KeyE: () => this.addLayerTo(this.agents[this.focused], "editor"),
      KeyU: () => void checkForUpdates({ silent: false }), // manual "check for updates"
      KeyG: () => this.openMemoryDialog(), // project memory (personal unconscious)
      KeyC: () => this.openCommandDialog(), // Claude Code command palette
      KeyS: () => this.openSkillsDialog(), // Claude Code skills browser
      KeyO: () => this.openFilesDialog(), // in-app file browser → open in editor
      KeyW: () => this.closeLayerAt(this.agents[this.focused], this.agents[this.focused]?.active ?? 0),
      KeyX: () => this.closeAgentObj(this.agents[this.focused]),
      KeyP: () => this.switchProject(1),
      KeyM: () => this.toggleMacro(),
      KeyD: () => {
        // Alt+Shift+D: dump the focused terminal's alt-screen buffer (vim
        // diagnostic — "populated but not painted" vs "empty"). Plain Alt+D
        // toggles the input tracer overlay.
        if (e.shiftKey) {
          const f = this.agents[this.focused]?.layers[this.agents[this.focused].active];
          if (f?.kind === "terminal") toast(`vim-dump: ${dumpLayerBuffer(f)}`);
          return;
        }
        toast(`debug ${toggleDbg() ? "on" : "off"}`);
      },
      KeyR: () => {
        if (e.shiftKey) return this.launchAll();
        const a = this.agents[this.focused];
        if (a && !a.running) this.launchAgent(a);
      },
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
    // Keep `focused` in range for the current project (switching to a project
    // with fewer agents could otherwise leave it pointing past the end, so no
    // window shows the focus ring — "nothing is focused").
    const n = this.agents.length;
    if (n > 0 && (this.focused < 0 || this.focused >= n)) {
      this.focused = Math.max(0, Math.min(this.focused, n - 1));
    }
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
      resetLayer: (agent, ai) => {
        this.focused = ai;
        this.resetFrontTerminal(agent);
      },
      afterRender: () => {
        this.scheduleFit();
        // Also re-fit once the layout has settled. Closing/adding a window
        // re-flows the grid and can leave a terminal with a stale (too-tall) row
        // count, which clips claude's multi-line input at the card's bottom edge.
        this.refitSoon();
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
      urlExternal: this.urlExternal,
      autoResume: this.autoResume,
      autoStart: this.autoStart,
      newWindowAnchor: this.newWindowAnchor,
      newWindowPath: this.newWindowPath,
    });
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const snap = this.snapshot();
      saveSnap(snap); // fast per-viewer copy (localStorage)
      void this.saveSnapFile(snap); // durable on-disk mirror (survives storage/engine changes)
    }, 400);
  }

  /// Stable on-disk mirror of the workspace, independent of the webview's storage engine.
  /// localStorage moved when the engine switched (WKWebView→CEF), silently losing the
  /// workspace; this file lives in the user's home and survives engine/storage changes and
  /// reinstalls, and startup falls back to it when localStorage is empty.
  private workspaceFile(): string {
    return `${this.home.replace(/\/$/, "")}/.aidt/workspace.json`;
  }
  private async saveSnapFile(snap: WorkspaceSnap) {
    try {
      await writeFile(this.workspaceFile(), JSON.stringify(snap));
    } catch {
      /* non-fatal: the localStorage copy still holds it */
    }
  }
  private async loadSnapFile(): Promise<WorkspaceSnap | null> {
    try {
      const snap = JSON.parse(await readFile(this.workspaceFile())) as WorkspaceSnap;
      return snap?.projects?.length ? snap : null;
    } catch {
      return null;
    }
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
    this.urlExternal = !!snap.urlExternal;
    this.autoResume = !!snap.autoResume;
    this.autoStart = snap.autoStart ?? true; // default on (preserve prior behavior)
    this.newWindowAnchor = snap.newWindowAnchor ?? "focused";
    this.newWindowPath = snap.newWindowPath ?? "";
    if (snap.presets) this.presets = new Set(snap.presets);
    if (snap.agentPresets?.length) this.agentPresets = snap.agentPresets;

    this.ap = restoreProjects(snap, this.projects, this.agentCmd, {
      newAgent: (p, cwd) => this.newAgent(p, cwd),
      // Resume the agent command on restore only when it was running AND the
      // user opted into auto-resume; otherwise the window comes up as an idle
      // shell and the ▶ button (or Alt+R) starts it on demand.
      primaryLayer: (cwd, cmd, autoRun) => this.primaryLayer(cwd, cmd, autoRun && this.autoResume),
      shellLayer: (cwd) => this.shellLayer(cwd),
      createBrowserLayer,
      observeLayer: (l) => this.observeLayer(l),
      fillAgentSelect: (a) => this.fillAgentSelect(a),
      refreshBranch: (a) => void this.refreshBranch(a),
    });
    // Restored windows carry their persisted priority — arrange each project so
    // the order matches (also fixes up workspaces saved before auto-sort existed).
    for (const p of this.projects) sortByPriority(p.agents);
  }

  /// Restore on launch: prefer localStorage (fast), else fall back to the on-disk mirror
  /// (e.g. right after a storage-engine change wiped localStorage), re-seeding localStorage
  /// from the file so later saves stay consistent.
  private async restore(): Promise<boolean> {
    const snap = loadSnap();
    if (snap?.projects?.length) {
      this.applySnapshot(snap);
      return true;
    }
    const fileSnap = await this.loadSnapFile();
    if (fileSnap?.projects?.length) {
      this.applySnapshot(fileSnap);
      saveSnap(fileSnap); // re-seed the fast copy from the durable one
      return true;
    }
    return false;
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
      exportFile: () => void this.exportWorkspace(),
      importFile: () => void this.importWorkspace(),
    });
  }

  /// Export the whole workspace (projects/agents/cwd/layout/toggles) to a portable .json
  /// file — a backup that survives storage-engine changes (e.g. the WKWebView→CEF move),
  /// reinstalls and new machines, independent of the in-app save slots (localStorage).
  private async exportWorkspace() {
    const name = `aidt-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    const p = await pickSavePath(name);
    if (!p) return;
    try {
      await writeFile(p, JSON.stringify(this.snapshot(), null, 2));
      toast(t("saves.exported", basename(p)));
    } catch (e) {
      toast(t("saves.exportFail", String(e)), "error");
    }
  }

  /// Replace the workspace from a .json file written by exportWorkspace. Confirms first
  /// (it wipes the current workspace) and stashes an undo auto-backup, like loadSlot.
  private async importWorkspace() {
    const p = await pickFile();
    if (!p) return;
    let snap: WorkspaceSnap;
    try {
      snap = JSON.parse(await readFile(p)) as WorkspaceSnap;
    } catch (e) {
      toast(t("saves.importFail", String(e)), "error");
      return;
    }
    if (!snap || typeof snap !== "object" || !Array.isArray(snap.projects)) {
      toast(t("saves.importInvalid"), "error");
      return;
    }
    const ok = await confirmModal({
      title: t("saves.confirmImport"),
      body: t("saves.confirmBody"),
      confirm: t("saves.confirmBtn"),
      danger: true,
    });
    if (!ok) return;
    upsertSave(t("saves.autoBackup"), this.snapshot());
    for (const pr of this.projects) for (const a of pr.agents) a.layers.forEach(disposeLayer);
    this.projects.length = 0;
    this.grid.replaceChildren();
    this.focused = 0;
    this.view = "project";
    this.applySnapshot(snap);
    this.render();
    toast(t("saves.imported"));
  }

  private async loadSlot(name: string): Promise<boolean> {
    const snap = getSave(name);
    if (!snap) return false;
    // Loading REPLACES the whole current workspace — confirm first (this used to
    // fire instantly on click and wipe everything), and stash the current state
    // into an auto-backup slot so the load is undoable.
    const ok = await confirmModal({
      title: t("saves.confirmLoad", name),
      body: t("saves.confirmBody"),
      confirm: t("saves.confirmBtn"),
      danger: true,
    });
    if (!ok) return false;
    upsertSave(t("saves.autoBackup"), this.snapshot());
    for (const p of this.projects) for (const a of p.agents) a.layers.forEach(disposeLayer);
    this.projects.length = 0;
    this.grid.replaceChildren();
    this.focused = 0;
    this.view = "project";
    this.applySnapshot(snap);
    this.render();
    toast(t("saves.loadedUndo", name));
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
            // Fit the terminal to its cell BEFORE spawning, so the shell/prompt
            // starts at the real size. Spawning at the default 80×24 and resizing
            // after can make a prompt (e.g. p10k) probe the cursor at the wrong
            // size and spin on `\e[6n`/CPR replies — the "blank + pegged CPU"
            // terminal. Correct size up front avoids that handshake loop.
            fitLayer(front);
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
      else if (f?.editorView) f.editorView.focus();
    });
  }
}
