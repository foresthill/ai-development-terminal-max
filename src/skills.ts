// Bridge to the Rust skills scanner (claude_skills.rs) for the Skills browser panel.
// Skills are discovered from the filesystem: a project's `.claude/skills`, the user's
// `~/.claude/skills`, and plugin skills under `~/.claude/plugins`.
import { invoke } from "@tauri-apps/api/core";

export interface SkillInfo {
  name: string;
  description: string;
  source: "project" | "user" | "plugin";
  /** Owning plugin for a plugin skill (else ""). */
  plugin: string;
  path: string;
}

/// Scan every discoverable Claude Code skill (project + user + plugins). Best-effort:
/// resolves to [] off-Tauri or when `~/.claude` is absent, so the UI degrades cleanly.
export async function claudeSkills(projectCwd: string | null): Promise<SkillInfo[]> {
  try {
    return await invoke<SkillInfo[]>("claude_skills", { projectCwd: projectCwd ?? "" });
  } catch {
    return [];
  }
}

/// The exact slash form a person types to invoke a skill. Plugin skills are namespaced
/// `/<plugin>:<name>` (so they can't collide with project/personal skills); project and
/// user skills are `/<name>`. Verified against code.claude.com/docs/en/skills +
/// slash-commands.
export function skillInvocation(s: SkillInfo): string {
  return s.source === "plugin" && s.plugin ? `/${s.plugin}:${s.name}` : `/${s.name}`;
}
