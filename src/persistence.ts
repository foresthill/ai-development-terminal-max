// Workspace snapshot <-> localStorage. Holds no app logic; the App rebuilds live
// objects from a loaded snapshot.
import { Project } from "./project";
import { PermMode } from "./render";

const STORE_KEY = "aidt-workspace";

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
        layers: a.layers.map((l) => ({ kind: l.kind, title: l.title, url: l.iframe?.src })),
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
