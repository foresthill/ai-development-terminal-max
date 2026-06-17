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
import { defaultShell, homeDir } from "./pty";
import { isGitRepo, gitClone, createWorktree, writeGuardrails } from "./git";
import { askText, toast, pickDirectory, openSettings } from "./ui";
import { GUARD_PRESETS, effectiveDeny } from "./guard";
import { renderAll, RenderCtx, Mode, View, PermMode } from "./render";
import { buildSnapshot, saveSnap, loadSnap } from "./persistence";

const ymd = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

export class App {
  private projects: Project[] = [];
  private ap = 0;
  private focused = 0;
  private mode: Mode = "overview";
  private view: View = "project";
  private layout: "square" | "fit" = "square";
  private permMode: PermMode = "auto";
  private guardrails = false;
  private agentCmd = "claude";
  private presets = new Set<string>(GUARD_PRESETS.map((p) => p.id));
  private customDeny = "";
  private guardWritten = new Set<string>();
  private shell = "/bin/zsh";
  private home = "";
  private agentSeq = 1;

  private grid: HTMLElement;
  private macroEl: HTMLElement;
  private stripEl: HTMLElement;
  private countEl: HTMLElement;
  private btnLayout: HTMLElement;
  private btnGuard: HTMLElement;
  private permSelect: HTMLSelectElement;
  private resizeObs: ResizeObserver;

  constructor(root: HTMLElement) {
    this.grid = root.querySelector("#grid")!;
    this.macroEl = root.querySelector("#macro")!;
    this.stripEl = root.querySelector("#project-strip")!;
    this.countEl = root.querySelector("#agent-count")!;
    this.btnLayout = root.querySelector("#btn-layout")!;
    this.btnGuard = root.querySelector("#btn-guard")!;
    this.permSelect = root.querySelector("#perm-mode")!;
    this.resizeObs = new ResizeObserver(() => this.scheduleFit());

    root.querySelector("#btn-add")!.addEventListener("click", () => this.addAgentToActive());
    root.querySelector("#btn-fill")!.addEventListener("click", () => this.fill());
    root.querySelector("#btn-zoom")!.addEventListener("click", () => this.toggleZoom());
    root.querySelector("#btn-macro")!.addEventListener("click", () => this.toggleMacro());
    root.querySelector("#btn-open")!.addEventListener("click", () => this.openFolderProject());
    root.querySelector("#btn-clone")!.addEventListener("click", () => this.cloneProject());
    root.querySelector("#btn-guard")!.addEventListener("click", () => this.toggleGuardrails());
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
    window.addEventListener("resize", () => this.scheduleFit());
  }

  async init() {
    this.shell = await defaultShell();
    this.home = await homeDir();
    if (!this.restore()) {
      const p = createProject("local", this.home, false);
      this.projects.push(p);
      for (let i = 0; i < 3; i++) await this.addAgentWithCwd(p, this.home, false);
    }
    this.render();
  }

  private get curProject(): Project | undefined {
    return this.projects[this.ap];
  }
  private get agents(): Agent[] {
    return this.curProject?.agents ?? [];
  }

  // --- agent command (configurable) ----------------------------------------

  private buildAgentCmd(): string {
    const base = this.agentCmd.trim() || "claude";
    if (base.startsWith("claude")) {
      if (this.permMode === "auto") return `${base} --permission-mode auto`;
      if (this.permMode === "bypass") return `${base} --dangerously-skip-permissions`;
    }
    return base;
  }
  private claudeLayer(cwd: string | null): Layer {
    return createTerminalLayer({
      title: "claude",
      shell: this.shell,
      args: ["-l", "-c", `${this.buildAgentCmd()}; exec ${this.shell} -l`],
      cwd,
    });
  }
  private shellLayer(cwd: string | null): Layer {
    return createTerminalLayer({ title: "shell", shell: this.shell, args: ["-l"], cwd });
  }

  // --- agent lifecycle ------------------------------------------------------

  private newAgent(project: Project, cwd: string | null): Agent {
    const agent = createAgent(this.agentSeq++);
    agent.cwd = cwd;
    agent.pathEl.value = cwd ?? "";
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
    return agent;
  }

  private async addAgentWithCwd(project: Project, cwd: string | null, focus = true) {
    const agent = this.newAgent(project, cwd);
    agent.title = cwd && cwd !== this.home ? basename(cwd) : `agent ${this.agentSeq - 1}`;
    await this.applyGuard(cwd);
    const layer = this.claudeLayer(cwd);
    agent.layers.push(layer);
    this.observeLayer(layer);
    if (focus) {
      this.ap = this.projects.indexOf(project);
      this.focused = project.agents.length - 1;
    }
    this.render();
  }

  private async addAgentToActive() {
    const p = this.curProject;
    if (!p) {
      toast("プロジェクトがありません。folder か clone で作成してください", "error");
      return;
    }
    if (p.isGit) {
      const branch = `feature/${ymd()}-${p.agents.length + 1}`;
      try {
        const wt = await createWorktree(p.root, branch);
        await this.addAgentWithCwd(p, wt);
        toast(`worktree: ${branch}`);
      } catch (e) {
        toast(`worktree作成失敗: ${e}`, "error");
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
          toast(`worktree作成失敗: ${e}`, "error");
          break;
        }
      } else {
        await this.addAgentWithCwd(p, p.root || this.home, false);
      }
    }
    this.render();
  }

  // --- guardrails -----------------------------------------------------------

  private async applyGuard(cwd: string | null) {
    // Skip home (would touch ~/.claude, the user's own config) and re-writes.
    if (!this.guardrails || !cwd || cwd === this.home || this.guardWritten.has(cwd)) return;
    try {
      await writeGuardrails(cwd, effectiveDeny(this.presets, this.customDeny));
      this.guardWritten.add(cwd);
    } catch (e) {
      toast(`guard書込失敗: ${e}`, "error");
    }
  }

  private async toggleGuardrails() {
    this.guardrails = !this.guardrails;
    if (this.guardrails) {
      const dirs = new Set<string>();
      for (const p of this.projects) for (const a of p.agents) if (a.cwd) dirs.add(a.cwd);
      for (const d of dirs) await this.applyGuard(d);
      toast(`guardrails ON — deny-list を書込（再起動した claude から有効）`);
    } else {
      toast("guardrails OFF — 既存ファイルは残します");
    }
    this.render();
  }

  // --- per-agent cwd / title ------------------------------------------------

  private async setAgentCwd(agent: Agent, path: string) {
    agent.cwd = path;
    agent.pathEl.value = path;
    if (!agent.manualTitle) agent.title = basename(path);
    await this.applyGuard(path);
    const old = agent.layers[0];
    const fresh = this.claudeLayer(path);
    disposeLayer(old);
    agent.layers[0] = fresh;
    agent.active = 0;
    agent.stackEl.insertBefore(fresh.el, agent.stackEl.firstChild);
    this.observeLayer(fresh);
    this.render();
  }

  private addLayer(kind: "terminal" | "browser") {
    const agent = this.agents[this.focused];
    if (!agent) return;
    const layer =
      kind === "browser" ? createBrowserLayer("http://localhost:3000") : this.shellLayer(agent.cwd);
    agent.layers.push(layer);
    agent.active = agent.layers.length - 1;
    agent.stackEl.appendChild(layer.el);
    if (kind === "terminal") this.observeLayer(layer);
    this.render();
  }

  private closeLayer() {
    const agent = this.agents[this.focused];
    if (!agent || agent.layers.length <= 1) return;
    const [removed] = agent.layers.splice(agent.active, 1);
    disposeLayer(removed);
    agent.active = Math.min(agent.active, agent.layers.length - 1);
    this.render();
  }

  private closeAgent() {
    const p = this.curProject;
    const agent = this.agents[this.focused];
    if (!p || !agent) return;
    agent.layers.forEach(disposeLayer);
    p.agents.splice(this.focused, 1);
    this.focused = Math.max(0, Math.min(this.focused, p.agents.length - 1));
    if (p.agents.length === 0) this.mode = "overview";
    this.render();
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
        title: "プロジェクトを開く（フォルダ/リポのパス）",
        placeholder: "/Users/you/dev/myrepo",
        value: this.home + "/",
      });
    }
    if (!path) return;
    const git = await isGitRepo(path);
    const p = createProject(basename(path) || path, path, git);
    this.projects.push(p);
    this.ap = this.projects.length - 1;
    this.focused = 0;
    this.view = "project";
    if (p.isGit) await this.addAgentToActive();
    else await this.addAgentWithCwd(p, path);
  }

  private async cloneProject() {
    const url = await askText({
      title: "git clone（リポジトリURL）",
      placeholder: "https://github.com/user/repo.git",
    });
    if (!url) return;
    toast(`cloning ${url} …`);
    try {
      const path = await gitClone(url);
      const p = createProject(basename(path) || "repo", path, true);
      this.projects.push(p);
      this.ap = this.projects.length - 1;
      this.focused = 0;
      this.view = "project";
      await this.addAgentToActive();
      toast(`cloned: ${basename(path)}`);
    } catch (e) {
      toast(`clone失敗: ${e}`, "error");
    }
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
      agentCmd: this.agentCmd,
      permMode: this.permMode,
      enabled: new Set(this.presets),
      customDeny: this.customDeny,
    });
    if (!res) return;
    this.agentCmd = res.agentCmd;
    this.permMode = res.permMode;
    this.presets = res.enabled;
    this.customDeny = res.customDeny;
    if (this.guardrails) {
      this.guardWritten.clear(); // rewrite our files with the new deny-list
      const dirs = new Set<string>();
      for (const p of this.projects) for (const a of p.agents) if (a.cwd) dirs.add(a.cwd);
      for (const d of dirs) await this.applyGuard(d);
      toast("設定を保存。deny-list を再書込（再起動した claude から有効）");
    } else {
      toast("設定を保存");
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
      KeyN: () => this.addLayer("terminal"),
      KeyB: () => this.addLayer("browser"),
      KeyW: () => this.closeLayer(),
      KeyX: () => this.closeAgent(),
      KeyP: () => this.switchProject(1),
      KeyM: () => this.toggleMacro(),
    };
    let fn = handlers[e.code];
    if (!fn && /^Digit[1-9]$/.test(e.code)) {
      const n = parseInt(e.code.slice(5), 10) - 1;
      fn = () => {
        this.view = "project";
        this.focus(n);
        if (n < this.agents.length) this.mode = "zoom";
        this.render();
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
      permSelect: this.permSelect,
      projects: this.projects,
      ap: this.ap,
      focused: this.focused,
      mode: this.mode,
      view: this.view,
      layout: this.layout,
      permMode: this.permMode,
      guardrails: this.guardrails,
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
          ap: this.ap,
          agentCmd: this.agentCmd,
          presets: [...this.presets],
          customDeny: this.customDeny,
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
    this.agentCmd = snap.agentCmd || "claude";
    this.customDeny = snap.customDeny ?? "";
    if (snap.presets) this.presets = new Set(snap.presets);

    for (const ps of snap.projects) {
      const p = createProject(ps.name ?? "project", ps.root ?? "", !!ps.isGit);
      this.projects.push(p);
      for (const as of ps.agents ?? []) {
        const agent = this.newAgent(p, as.cwd ?? null);
        agent.title = as.title ?? agent.title;
        agent.manualTitle = !!as.manualTitle;
        for (let li = 0; li < (as.layers ?? []).length; li++) {
          const ls = as.layers[li];
          let layer: Layer;
          if (ls.kind === "browser") layer = createBrowserLayer(ls.url || "http://localhost:3000");
          else if (li === 0 || ls.title === "claude") layer = this.claudeLayer(as.cwd ?? null);
          else layer = this.shellLayer(as.cwd ?? null);
          agent.layers.push(layer);
          agent.stackEl.appendChild(layer.el);
          if (layer.kind === "terminal") this.observeLayer(layer);
        }
        if (agent.layers.length === 0) {
          const l = this.claudeLayer(as.cwd ?? null);
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
              .catch(() =>
                front.term?.write("\r\n\x1b[31m[spawn failed: check the directory path]\x1b[0m\r\n")
              );
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
