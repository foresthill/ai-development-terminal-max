// Automatic Claude-session long-term memory (see
// docs/2026-11-10-claude-session-harvest-longterm-memory.md).
//
// The user's hard requirement: long-term memory is NOT hand-typed notes. It is the
// app automatically HARVESTING Claude Code's own sessions and PRESERVING them in our
// durable store — because Claude's session storage is unreliable (sessions can fail to
// resume or vanish). Claude's ~/.claude/projects/*.jsonl is read only as a *fragile
// source*; the durable copy lives in our SQLite memory (memory.db), survives Claude
// losing the original, and is exportable (no lock-in).
//
// This module is the bridge: read live digests from Rust (claude_sessions.rs), sediment
// them into `memory` keyed by sessionId, read them back, and merge the two for a global
// overview that flags sessions Claude has since lost.

import { invoke } from "@tauri-apps/api/core";
import { memory, type Memory } from "./memory";
import { distill, type Insights } from "./distill";

/** One Claude session, digested by the Rust side (camelCase matches the Rust serde). */
export interface SessionDigest {
  sessionId: string;
  cwd: string;
  /** Last path segment of cwd — a readable project label. */
  project: string;
  gitBranch: string;
  slug: string;
  title: string;
  firstTs: string;
  lastTs: string;
  messages: number;
}

/** A session for the overview: a digest plus whether Claude still has its jsonl. */
export interface MergedSession extends SessionDigest {
  /** true = Claude no longer has this session, but we preserved the digest. */
  lostByClaude: boolean;
}

/** Tag every harvested session carries, so they're findable among other memories. */
export const SESSION_TAG = "claude-session";

/** Tag the distilled "insight" memories carry (kept separate from raw sessions). */
export const DISTILL_TAG = "distilled";

/** Stable memory id for a session, so re-harvesting upserts rather than duplicates. */
const idFor = (sessionId: string): string => `claude-session-${sessionId}`;

/// Read every Claude session on this machine, live from ~/.claude (newest first).
/// `onlyCwd` limits to one project. Returns [] in a non-Tauri context or when ~/.claude
/// is absent — the UI then simply shows nothing rather than erroring.
export async function claudeSessions(onlyCwd = ""): Promise<SessionDigest[]> {
  try {
    return await invoke<SessionDigest[]>("claude_sessions", { onlyCwd });
  } catch {
    return [];
  }
}

/// Harvest: persist every live session digest into our durable store, keyed by
/// sessionId (so a growing session updates in place). THIS is the long-term memory —
/// once harvested, a session survives even if Claude later loses its jsonl. Returns the
/// number of sessions seen.
export async function harvestSessions(onlyCwd = ""): Promise<number> {
  const live = await claudeSessions(onlyCwd);
  for (const d of live) {
    memory.upsert(idFor(d.sessionId), {
      scope: "collective", // cross-project: the global "survey all sessions" layer
      kind: "summary",
      title: d.title || d.slug || d.sessionId,
      body: JSON.stringify(d), // full digest, so we can reconstruct even if Claude loses it
      tags: [SESSION_TAG, `proj:${d.project}`, d.gitBranch].filter(Boolean),
      salience: d.messages, // busier sessions surface first
    });
  }
  // Learn (heuristic): re-distill from everything preserved so far and persist it as
  // durable insight memories — the "survey all sessions and learn from them" layer.
  persistInsights(sessionInsights());
  return live.length;
}

const fmtDay = (iso: string): string => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? (iso || "") : d.toISOString().slice(0, 10);
};

/// Persist distilled insights as durable, exportable "insight" memories (one global, one
/// per project), upserted by stable id so each harvest refreshes them in place.
export function persistInsights(ins: Insights): void {
  const g = ins.global;
  const topics = g.topics.map((t) => `${t.term}(${t.count})`).join(", ");
  const busiest = g.busiest.map((b) => `${b.project}(${b.sessions})`).join(", ");
  memory.upsert("insight-global", {
    scope: "collective",
    kind: "summary",
    title: `Overall: ${g.sessions} sessions · ${g.messages} msgs · ${g.projects} projects`,
    body: [busiest && `busiest: ${busiest}`, topics && `topics: ${topics}`].filter(Boolean).join("\n"),
    tags: [DISTILL_TAG, "insight"],
    salience: g.sessions,
  });
  for (const p of ins.projects) {
    memory.upsert(`insight-proj-${p.project}`, {
      scope: "collective",
      kind: "summary",
      title: `${p.project}: ${p.sessions} sessions · ${p.messages} msgs`,
      body: [
        p.branches.length ? `branches: ${p.branches.join(", ")}` : "",
        `active: ${fmtDay(p.firstTs)} → ${fmtDay(p.lastTs)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      tags: [DISTILL_TAG, "insight", `proj:${p.project}`],
      salience: p.sessions,
    });
  }
}

/// Distill insights from everything we've durably preserved (the full picture).
export function sessionInsights(): Insights {
  return distill(persistedSessions());
}

/// Reconstruct a digest from a persisted session memory (its body holds the JSON).
function digestFromMemory(m: Memory): SessionDigest | null {
  try {
    const d = JSON.parse(m.body) as SessionDigest;
    return d && typeof d.sessionId === "string" ? d : null;
  } catch {
    return null;
  }
}

/// Every session we've durably preserved, newest activity first. This is what remains
/// when Claude's own storage is gone.
export function persistedSessions(): SessionDigest[] {
  return memory
    .query({ scope: "collective", limit: 100000 })
    .filter((m) => m.tags.includes(SESSION_TAG))
    .map(digestFromMemory)
    .filter((d): d is SessionDigest => d != null)
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

/// The overview source: harvest first (refresh the durable copy), then return the union
/// of live sessions and preserved-only sessions, newest first. A preserved session that
/// no longer appears live is flagged `lostByClaude` — the proof this feature matters.
export async function overviewSessions(): Promise<MergedSession[]> {
  await harvestSessions();
  const live = await claudeSessions();
  const liveIds = new Set(live.map((d) => d.sessionId));
  const merged: MergedSession[] = live.map((d) => ({ ...d, lostByClaude: false }));
  for (const d of persistedSessions()) {
    if (!liveIds.has(d.sessionId)) merged.push({ ...d, lostByClaude: true });
  }
  merged.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  return merged;
}
