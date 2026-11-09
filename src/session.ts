// Session model: one app launch is one "session". We stamp short-term (conscious)
// memories with the current session as a `session:<id>` tag, so the memory panel can
// show short-term memory grouped per session — the Orca-style session history, over
// the four-layer store (docs/2026-11-08-four-layer-memory-architecture.md).
//
// Deliberately tag-based (no schema/SQLite change): past sessions are reconstructed
// from the tags on conscious memories, newest first. The id embeds its start time so
// a header can show when the session began without a separate registry.

const PREFIX = "session:";

// One id per launch. `sess-<base36 epoch ms>-<rand>` — the time is recoverable.
const SESSION_ID = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function currentSessionId(): string {
  return SESSION_ID;
}

/// The tag to stamp on a conscious memory for a session (defaults to this launch's).
export function sessionTag(id: string = SESSION_ID): string {
  return PREFIX + id;
}

/// Pull the session id out of a memory's tags, or null if it carries none.
export function sessionIdFromTags(tags: string[]): string | null {
  const hit = tags.find((t) => t.startsWith(PREFIX));
  return hit ? hit.slice(PREFIX.length) : null;
}

/// Recover the start time (epoch ms) encoded in a session id, or null if it doesn't
/// match the expected shape (e.g. an externally-imported tag).
export function sessionStartedAt(id: string): number | null {
  const m = id.match(/^sess-([0-9a-z]+)-/);
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
