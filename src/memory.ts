// Four-layer memory store (Phase 1: the "personal unconscious" — per-project
// long-term memory). See docs/2026-11-08-four-layer-memory-architecture.md.
//
// The store is pure logic over a pluggable backend, so (a) it is unit-testable in
// Node with an in-memory backend, and (b) the durable backend can later swap from
// localStorage to SQLite (`memory.rs`) without touching callers. Phase 1a uses
// localStorage — one WKWebView origin, so it is already shared across every project
// and worktree in the app, and it survives restarts (same bundle id). Phase 1b
// moves it to SQLite for external access, embeddings and scale.
//
// The loop this enables:
//   sediment  — write a summary/decision into a project's memory (`write`)
//   recall    — pull the most relevant memories back for a new turn (`query`)

import { invoke } from "@tauri-apps/api/core";

export type MemoryScope = "conscious" | "personal" | "collective" | "super";
export type MemoryKind = "summary" | "decision" | "convention" | "goal" | "note";

export interface Memory {
  id: string;
  scope: MemoryScope;
  /** Required for `personal` (the owning project); null for collective/super. */
  projectId: string | null;
  /** Only for `conscious` (the owning agent); null otherwise. */
  agentId: string | null;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  /** Recall priority / sublimation threshold (higher = surfaced first). */
  salience: number;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms after which a (conscious) memory is dropped; null = permanent. */
  expiresAt: number | null;
}

/** Storage backend: the store reads all rows, mutates, and writes all back. Kept
 *  deliberately coarse — the row counts here are small, and it makes the SQLite
 *  swap a single-file change. */
export interface MemoryBackend {
  load(): Memory[];
  save(all: Memory[]): void;
}

/** Fields a caller supplies to sediment a memory; the store fills the rest. */
export interface MemoryInput {
  scope?: MemoryScope; // default "personal"
  projectId?: string | null;
  agentId?: string | null;
  kind?: MemoryKind; // default "note"
  title: string;
  body?: string;
  tags?: string[];
  salience?: number; // default 0
  /** ms from now until expiry (conscious only); omit for permanent. */
  ttlMs?: number;
}

export interface QueryOpts {
  scope?: MemoryScope;
  projectId?: string | null;
  /** Free-text; matched against title/body/tags, and boosts ranking. */
  text?: string;
  limit?: number; // default 20
  /** Include expired rows (default false). */
  includeExpired?: boolean;
}

/** Default lifetime for short-term (conscious) memories — auto-expire after ~7 days
 *  so the short-term layer stays "recent" without manual cleanup. */
export const SHORT_TERM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const now = () => Date.now();

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return "mem-" + crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "mem-" + Math.random().toString(36).slice(2, 10) + now().toString(36);
}

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** How many of `text`'s tokens appear in the memory (title/body/tags). */
function textMatchScore(m: Memory, text: string): number {
  const hay = (m.title + " " + m.body + " " + m.tags.join(" ")).toLowerCase();
  let hits = 0;
  for (const tk of new Set(tokens(text))) if (hay.includes(tk)) hits++;
  return hits;
}

const isExpired = (m: Memory, t: number): boolean => m.expiresAt != null && m.expiresAt <= t;

/// Pure ranking: salience first, then text relevance (when a query text is given),
/// then recency. Exported for the unit tests.
export function rankMemories(rows: Memory[], text?: string): Memory[] {
  const scored = rows.map((m) => ({ m, tx: text ? textMatchScore(m, text) : 0 }));
  scored.sort((a, b) => b.m.salience - a.m.salience || b.tx - a.tx || b.m.updatedAt - a.m.updatedAt);
  return scored.map((s) => s.m);
}

export class MemoryStore {
  constructor(private backend: MemoryBackend) {}

  /// Swap the storage backend (e.g. localStorage → SQLite at boot). The new backend
  /// already holds the hydrated rows, so callers see no interruption.
  setBackend(backend: MemoryBackend) {
    this.backend = backend;
  }

  private all(): Memory[] {
    return this.backend.load();
  }

  /// Sediment: create (or, with an existing id, nothing — writes are append-only
  /// here) a memory. Returns the stored row.
  write(input: MemoryInput): Memory {
    const t = now();
    const scope = input.scope ?? "personal";
    const m: Memory = {
      id: uid(),
      scope,
      projectId: input.projectId ?? null,
      agentId: input.agentId ?? null,
      kind: input.kind ?? "note",
      title: input.title.trim(),
      body: (input.body ?? "").trim(),
      tags: (input.tags ?? []).map((s) => s.trim()).filter(Boolean),
      salience: input.salience ?? 0,
      createdAt: t,
      updatedAt: t,
      expiresAt: input.ttlMs != null ? t + input.ttlMs : null,
    };
    const all = this.all();
    all.push(m);
    this.backend.save(all);
    return m;
  }

  /// Upsert by a caller-chosen STABLE id (e.g. a Claude sessionId) — one row per
  /// external key, updated in place when the source changes. Unlike `write` (which is
  /// append-only with a random id), this is how the session harvester keeps exactly one
  /// durable digest per Claude session and refreshes it as the session grows. Fields
  /// not supplied fall back to the existing row (or defaults), and createdAt is kept.
  upsert(id: string, input: MemoryInput): Memory {
    const t = now();
    const all = this.all();
    const prev = all.find((m) => m.id === id);
    const m: Memory = {
      id,
      scope: input.scope ?? prev?.scope ?? "personal",
      projectId: input.projectId ?? prev?.projectId ?? null,
      agentId: input.agentId ?? prev?.agentId ?? null,
      kind: input.kind ?? prev?.kind ?? "note",
      title: input.title.trim(),
      body: (input.body ?? prev?.body ?? "").trim(),
      tags: (input.tags ?? prev?.tags ?? []).map((s) => s.trim()).filter(Boolean),
      salience: input.salience ?? prev?.salience ?? 0,
      createdAt: prev?.createdAt ?? t,
      updatedAt: t,
      expiresAt: input.ttlMs != null ? t + input.ttlMs : (prev?.expiresAt ?? null),
    };
    if (prev) Object.assign(prev, m);
    else all.push(m);
    this.backend.save(all);
    return m;
  }

  /// Recall: the most relevant memories for a scope/project, ranked. Expired rows
  /// are excluded (and opportunistically pruned) unless `includeExpired`.
  query(opts: QueryOpts = {}): Memory[] {
    const t = now();
    let rows = this.all();
    let changed = false;
    if (!opts.includeExpired) {
      const kept = rows.filter((m) => !isExpired(m, t));
      if (kept.length !== rows.length) {
        this.backend.save(kept);
        changed = true;
      }
      rows = kept;
    }
    void changed;
    if (opts.scope) rows = rows.filter((m) => m.scope === opts.scope);
    if (opts.projectId !== undefined) rows = rows.filter((m) => m.projectId === opts.projectId);
    if (opts.text && opts.text.trim()) {
      const needles = opts.text;
      rows = rows.filter((m) => textMatchScore(m, needles) > 0);
    }
    const ranked = rankMemories(rows, opts.text);
    return ranked.slice(0, opts.limit ?? 20);
  }

  /// All memories for a project (unranked-by-default list view), newest first.
  listForProject(projectId: string, scope: MemoryScope = "personal"): Memory[] {
    const t = now();
    return this.all()
      .filter((m) => m.projectId === projectId && m.scope === scope && !isExpired(m, t))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Memory | undefined {
    return this.all().find((m) => m.id === id);
  }

  /// Bump salience (e.g. when a memory is recalled/used) — reinforces what matters.
  reinforce(id: string, by = 1): void {
    const all = this.all();
    const m = all.find((x) => x.id === id);
    if (!m) return;
    m.salience += by;
    m.updatedAt = now();
    this.backend.save(all);
  }

  delete(id: string): void {
    this.backend.save(this.all().filter((m) => m.id !== id));
  }

  /// Import memories (e.g. from an exported JSON file), de-duplicated by id.
  /// Returns how many were newly added. The open-format import/export is the
  /// anti-lock-in guarantee: your memory is never trapped in this app.
  importMany(rows: Memory[]): number {
    const all = this.all();
    const have = new Set(all.map((m) => m.id));
    let added = 0;
    for (const m of rows) {
      if (!have.has(m.id)) {
        all.push(m);
        have.add(m.id);
        added++;
      }
    }
    if (added) this.backend.save(all);
    return added;
  }

  /// Drop every expired row. Returns how many were removed.
  prune(): number {
    const t = now();
    const all = this.all();
    const kept = all.filter((m) => !isExpired(m, t));
    if (kept.length !== all.length) this.backend.save(kept);
    return all.length - kept.length;
  }
}

// --- portable import/export (no lock-in) ------------------------------------
// Memory must never be trapped in this app. These render/parse the open formats a
// human or another tool can use: Markdown (readable, Obsidian/Notion-friendly) and
// JSON (lossless, re-importable). This is the "memory is portable" guarantee.

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/// Render memories as a readable Markdown document (for an Obsidian vault, a repo
/// doc, pasting into another agent, …). Lossy for re-import — use JSON for that.
export function memoriesToMarkdown(rows: Memory[], title = "Memory"): string {
  const out: string[] = [`# ${title}`, ""];
  for (const m of rows) {
    out.push(`## ${m.title}`);
    const meta = [`kind: ${m.kind}`, `salience: ${m.salience}`];
    if (m.tags.length) meta.push(`tags: ${m.tags.join(", ")}`);
    meta.push(`created: ${isoDay(m.createdAt)}`);
    out.push(`*${meta.join(" · ")}*`, "");
    if (m.body) out.push(m.body, "");
  }
  return out.join("\n");
}

/// Render memories as lossless JSON (re-importable via memoriesFromJson).
export function memoriesToJson(rows: Memory[]): string {
  return JSON.stringify(rows, null, 2);
}

const SCOPES: MemoryScope[] = ["conscious", "personal", "collective", "super"];

/// Parse memories from exported JSON, keeping only well-formed rows and filling any
/// missing fields with safe defaults. Throws only if the text isn't a JSON array.
export function memoriesFromJson(text: string): Memory[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array of memories");
  const t = now();
  const out: Memory[] = [];
  for (const r of parsed as Record<string, unknown>[]) {
    if (!r || typeof r.title !== "string" || !r.title.trim()) continue;
    const scope = SCOPES.includes(r.scope as MemoryScope) ? (r.scope as MemoryScope) : "personal";
    out.push({
      id: typeof r.id === "string" ? r.id : uid(),
      scope,
      projectId: typeof r.projectId === "string" ? r.projectId : null,
      agentId: typeof r.agentId === "string" ? r.agentId : null,
      kind: typeof r.kind === "string" ? (r.kind as MemoryKind) : "note",
      title: r.title.trim(),
      body: typeof r.body === "string" ? r.body : "",
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((x): x is string => typeof x === "string") : [],
      salience: typeof r.salience === "number" ? r.salience : 0,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : t,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : t,
      expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : null,
    });
  }
  return out;
}

/// localStorage-backed store for the running app. Reads/writes are guarded so a
/// blocked or private-mode storage degrades to empty rather than throwing (per the
/// app's storage rules). One key holds the whole set — small by design.
const LS_KEY = "aidt-memory";

export function createLocalStorageBackend(key = LS_KEY): MemoryBackend {
  return {
    load(): Memory[] {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as Memory[]) : [];
      } catch {
        return [];
      }
    },
    save(all: Memory[]): void {
      try {
        localStorage.setItem(key, JSON.stringify(all));
      } catch {
        /* storage full / blocked — a per-viewer convenience, not critical */
      }
    },
  };
}

/// The app-wide store. Starts on the localStorage backend so it works immediately
/// and in non-Tauri contexts; `initCanonicalStore()` promotes it to SQLite at boot.
/// Tests construct their own store with an in-memory backend instead.
export const memory = new MemoryStore(createLocalStorageBackend());

// --- canonical SQLite store (phase 1b) --------------------------------------
// SQLite (~/.aidt/memory.db, via memory.rs) is the source of truth: durable,
// inspectable, portable, not trapped in the webview origin. We front it with an
// in-memory cache so MemoryStore's read/query API stays synchronous — reads hit the
// cache, every save write-through to SQLite asynchronously.

/// A backend whose reads come from an in-memory cache (hydrated from SQLite) and
/// whose writes update the cache and persist the whole set to SQLite. The table is
/// small, so a coarse whole-set write is fine and keeps the Rust side trivial.
export function createSqliteBackend(initial: Memory[]): MemoryBackend {
  let cache = initial.slice();
  return {
    load: () => cache.slice(),
    save: (all) => {
      cache = all.slice();
      // Fire-and-forget; last write wins. Failures are non-fatal (the cache still
      // serves this session), and the next successful save re-persists everything.
      void invoke("memory_write_all", { json: JSON.stringify(cache) }).catch(() => {});
    },
  };
}

/// Promote the app store to the canonical SQLite backend. Call once at boot. Hydrates
/// the cache from SQLite, migrates any pre-existing localStorage memories in once
/// (de-duped by id), then swaps the backend. On any failure (non-Tauri context,
/// SQLite unavailable) it leaves the localStorage backend in place — the feature
/// still works, just not canonically persisted yet.
export async function initCanonicalStore(): Promise<void> {
  try {
    const sqliteRows = memoriesFromJson(await invoke<string>("memory_read_all"));
    const haveIds = new Set(sqliteRows.map((m) => m.id));
    const migrated = createLocalStorageBackend().load().filter((m) => !haveIds.has(m.id));
    const merged = sqliteRows.concat(migrated);
    const backend = createSqliteBackend(merged);
    if (migrated.length) backend.save(merged); // persist the one-time migration
    memory.setBackend(backend);
  } catch {
    // Keep localStorage (web preview, or SQLite command unavailable).
  }
}
