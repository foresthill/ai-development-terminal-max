// Slice 2 (heuristic): "learn" from the harvested Claude sessions WITHOUT an LLM.
// See docs/2026-11-10-claude-session-harvest-longterm-memory.md §5(a).
//
// Pure, mechanical aggregation over SessionDigest[] — so it is unit-testable and cheap:
// per-project stats (session/message counts, branches, activity span) and a global
// survey (totals, busiest projects, frequent title topics). The overview panel renders
// this, and claude-sessions.ts persists it as durable "insight" memories (exportable),
// so the learning survives even when Claude loses the underlying sessions.

import type { SessionDigest } from "./claude-sessions";

export interface ProjectInsight {
  project: string;
  sessions: number;
  messages: number;
  branches: string[];
  firstTs: string;
  lastTs: string;
}

export interface TopicCount {
  term: string;
  count: number;
}

export interface GlobalInsight {
  sessions: number;
  messages: number;
  projects: number;
  /** Projects with the most sessions, busiest first. */
  busiest: { project: string; sessions: number }[];
  /** Frequent words across session titles, most frequent first. */
  topics: TopicCount[];
}

export interface Insights {
  global: GlobalInsight;
  projects: ProjectInsight[];
}

// Pure stop-words (articles / prepositions / conjunctions / pronouns / auxiliaries) so
// topic extraction keeps meaningful verbs & nouns. Deliberately small and generic.
const STOP = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "at", "by", "with",
  "from", "into", "as", "is", "are", "be", "was", "were", "it", "its", "this", "that",
  "these", "those", "i", "we", "you", "he", "she", "they", "my", "our", "your", "me",
  "not", "no", "do", "does", "did", "so", "but", "if", "then", "than", "up", "out",
  "via", "per", "about", "over", "under",
]);

/** Title → lowercase word tokens (letters/numbers), dropping stop-words and 1–2 char
 *  fragments. Japanese runs stay whole (no spaces), so they rarely surface as repeated
 *  topics — acceptable for a heuristic; English titles are the common case. */
function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

const maxTs = (a: string, b: string): string => (a > b ? a : b);
const minTs = (a: string, b: string): string => (a && a < b ? a : b || a);

/// Distill a set of session digests into per-project and global insights. Pure.
export function distill(sessions: SessionDigest[]): Insights {
  const byProject = new Map<string, ProjectInsight>();
  const topicCounts = new Map<string, number>();
  let messages = 0;

  for (const s of sessions) {
    messages += s.messages || 0;
    const key = s.project || s.cwd || "—";
    let p = byProject.get(key);
    if (!p) {
      p = { project: key, sessions: 0, messages: 0, branches: [], firstTs: s.firstTs, lastTs: s.lastTs };
      byProject.set(key, p);
    }
    p.sessions += 1;
    p.messages += s.messages || 0;
    if (s.gitBranch && !p.branches.includes(s.gitBranch)) p.branches.push(s.gitBranch);
    if (s.firstTs) p.firstTs = minTs(p.firstTs, s.firstTs);
    if (s.lastTs) p.lastTs = maxTs(p.lastTs, s.lastTs);

    for (const tok of new Set(titleTokens(s.title || ""))) {
      topicCounts.set(tok, (topicCounts.get(tok) ?? 0) + 1);
    }
  }

  const projects = [...byProject.values()].sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  const busiest = [...byProject.values()]
    .map((p) => ({ project: p.project, sessions: p.sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.project.localeCompare(b.project))
    .slice(0, 5);
  const topics = [...topicCounts.entries()]
    .map(([term, count]) => ({ term, count }))
    .filter((t) => t.count >= 2) // a topic must recur across ≥2 sessions
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, 12);

  return {
    global: {
      sessions: sessions.length,
      messages,
      projects: byProject.size,
      busiest,
      topics,
    },
    projects,
  };
}
