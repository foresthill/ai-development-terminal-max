// Workspace snapshot <-> localStorage. Holds no app logic; the App rebuilds live
// objects from a loaded snapshot.
import { Project, createProject } from "./project";
import { Agent, Layer } from "./agent";
import { PermMode } from "./render";

const STORE_KEY = "aidt-workspace";
const PROJECTS_KEY = "aidt-projects";

/// Saved project bookmarks (label + path), like save slots: reopen later.
export interface SavedProject {
  label: string;
  path: string;
  isGit: boolean;
}

export function saveProjects(list: SavedProject[]) {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function loadProjects(): SavedProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    const list = raw ? (JSON.parse(raw) as SavedProject[]) : [];
    return Array.isArray(list) ? list.filter((p) => p && p.path) : [];
  } catch {
    return [];
  }
}

export interface AgentPresetSnap {
  label: string;
  cmd: string;
}

export interface LayerSnap { kind: "terminal" | "browser"; title: string; url?: string }
export interface AgentSnap {
  title: string;
  cwd: string | null;
  branch?: string;
  agentCmd?: string;
  manualTitle: boolean;
  active: number;
  layers: LayerSnap[];
}
export interface ProjectSnap { name: string; root: string; isGit: boolean; agents: AgentSnap[] }
export interface WorkspaceSnap {
  layout: "square" | "fit";
  permMode: PermMode;
  guardrails?: boolean;
  subagentNest?: boolean;
  ap: number;
  agentCmd?: string;
  presets?: string[];
  customDeny?: string;
  agentPresets?: AgentPresetSnap[];
  projects: ProjectSnap[];
}

export interface Settings {
  layout: "square" | "fit";
  permMode: PermMode;
  guardrails: boolean;
  subagentNest: boolean;
  ap: number;
  agentCmd: string;
  presets: string[];
  customDeny: string;
  agentPresets: AgentPresetSnap[];
}

export function buildSnapshot(projects: Project[], s: Settings): WorkspaceSnap {
  return {
    layout: s.layout,
    permMode: s.permMode,
    guardrails: s.guardrails,
    subagentNest: s.subagentNest,
    ap: s.ap,
    agentCmd: s.agentCmd,
    presets: s.presets,
    customDeny: s.customDeny,
    agentPresets: s.agentPresets,
    projects: projects.map((p) => ({
      name: p.name,
      root: p.root,
      isGit: p.isGit,
      agents: p.agents.map((a) => ({
        title: a.title,
        cwd: a.cwd,
        branch: a.branch,
        agentCmd: a.agentCmd,
        manualTitle: a.manualTitle,
        active: a.active,
        layers: a.layers
          .filter((l) => l.kind !== "subagent") // ephemeral — never persisted
          .map((l) => ({
            kind: l.kind as "terminal" | "browser",
            title: l.title,
            url: l.iframe?.src,
          })),
      })),
    })),
  };
}

export function saveSnap(snap: WorkspaceSnap) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(snap));
  } catch {
    // storage unavailable — non-fatal.
  }
}

export function loadSnap(): WorkspaceSnap | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as WorkspaceSnap) : null;
  } catch {
    return null;
  }
}

/// App-provided factories the rebuild needs but cannot construct itself (they
/// close over App state: shell, agent wiring, layout observers).
export interface RestoreBuilder {
  newAgent(project: Project, cwd: string | null): Agent;
  primaryLayer(cwd: string | null, cmd: string): Layer;
  shellLayer(cwd: string | null): Layer;
  createBrowserLayer(url: string): Layer;
  observeLayer(layer: Layer): void;
  fillAgentSelect(agent: Agent): void;
  refreshBranch(agent: Agent): void;
}

/// Rebuild live Project/Agent/Layer objects from a snapshot into `projects`
/// (mutated in place) using App-provided builders. Returns the clamped active-
/// project index. Settings application (layout/permMode/toggles) stays in App;
/// this owns only the structural rebuild loop.
export function restoreProjects(
  snap: WorkspaceSnap,
  projects: Project[],
  defaultAgentCmd: string,
  b: RestoreBuilder
): number {
  for (const ps of snap.projects) {
    const p = createProject(ps.name ?? "project", ps.root ?? "", !!ps.isGit);
    projects.push(p);
    for (const as of ps.agents ?? []) {
      const agent = b.newAgent(p, as.cwd ?? null);
      agent.title = as.title ?? agent.title;
      agent.manualTitle = !!as.manualTitle;
      agent.branch = as.branch ?? "";
      agent.agentCmd = as.agentCmd || defaultAgentCmd;
      b.fillAgentSelect(agent);
      b.refreshBranch(agent);
      for (let li = 0; li < (as.layers ?? []).length; li++) {
        const ls = as.layers[li];
        let layer: Layer;
        if (ls.kind === "browser") layer = b.createBrowserLayer(ls.url || "http://localhost:3000");
        else if (li === 0) layer = b.primaryLayer(as.cwd ?? null, agent.agentCmd);
        else layer = b.shellLayer(as.cwd ?? null);
        agent.layers.push(layer);
        agent.stackEl.appendChild(layer.el);
        if (layer.kind === "terminal") b.observeLayer(layer);
      }
      if (agent.layers.length === 0) {
        const l = b.primaryLayer(as.cwd ?? null, agent.agentCmd);
        agent.layers.push(l);
        agent.stackEl.appendChild(l.el);
        b.observeLayer(l);
      }
      agent.active = Math.min(Math.max(0, as.active ?? 0), agent.layers.length - 1);
    }
  }
  return Math.min(Math.max(0, snap.ap ?? 0), projects.length - 1);
}
