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

  /// Drop every expired row. Returns how many were removed.
  prune(): number {
    const t = now();
    const all = this.all();
    const kept = all.filter((m) => !isExpired(m, t));
    if (kept.length !== all.length) this.backend.save(kept);
    return all.length - kept.length;
  }
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

/// The app-wide store (localStorage backend). Tests construct their own store with
/// an in-memory backend instead.
export const memory = new MemoryStore(createLocalStorageBackend());
