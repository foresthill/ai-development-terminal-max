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
  return live.length;
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
