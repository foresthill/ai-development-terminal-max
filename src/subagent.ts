// Frontend half of subagent nesting: turn "subagent" events (forwarded from the
// Rust watcher of Claude Code's SubagentStart/Stop hooks) into ephemeral nested
// cards in the matching agent's Z-stack. Pairs with src-tauri/src/subagent.rs.
import { Project } from "./project";
import { Agent, createSubagentLayer, disposeLayer } from "./agent";

function findByCwd(projects: Project[], cwd: string): Agent | undefined {
  for (const p of projects) for (const a of p.agents) if (a.cwd === cwd) return a;
  return undefined;
}

function removeBySubId(projects: Project[], subId: string, render: () => void) {
  for (const p of projects)
    for (const a of p.agents) {
      const li = a.layers.findIndex((l) => l.subId === subId);
      if (li >= 0) {
        disposeLayer(a.layers[li]);
        a.layers.splice(li, 1);
        a.active = Math.min(a.active, a.layers.length - 1);
        render();
        return;
      }
    }
}

/// Handle one forwarded hook payload. Correlates SubagentStart to an agent by
/// cwd (each worktree is unique) and SubagentStop by the subagent's agent_id.
export function handleSubagentEvent(
  p: Record<string, unknown>,
  projects: Project[],
  render: () => void
) {
  const event = String(p.hook_event_name ?? "");
  const id = String(p.agent_id ?? "");
  if (event === "SubagentStart") {
    const agent = findByCwd(projects, String(p.cwd ?? ""));
    if (agent && id) {
      const layer = createSubagentLayer(String(p.agent_type ?? "subagent"), id);
      agent.layers.push(layer);
      agent.active = agent.layers.length - 1;
      agent.stackEl.appendChild(layer.el);
      render();
    }
  } else if (event === "SubagentStop" && id) {
    removeBySubId(projects, id, render);
  }
}

export function clearSubagentLayers(projects: Project[], render: () => void) {
  for (const p of projects)
    for (const a of p.agents) {
      a.layers.filter((l) => l.kind === "subagent").forEach(disposeLayer);
      a.layers = a.layers.filter((l) => l.kind !== "subagent");
      a.active = Math.min(a.active, a.layers.length - 1);
    }
  render();
}
