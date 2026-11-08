import { describe, it, expect } from "vitest";
import { MemoryStore, rankMemories, type Memory, type MemoryBackend } from "./memory";

// In-memory backend so the store's pure logic is testable in Node (no localStorage).
function memBackend(): MemoryBackend {
  let rows: Memory[] = [];
  return {
    load: () => rows.slice(),
    save: (all) => {
      rows = all.slice();
    },
  };
}

const store = () => new MemoryStore(memBackend());

describe("MemoryStore — sediment + recall", () => {
  it("writes a personal memory and recalls it for its project", () => {
    const s = store();
    s.write({ projectId: "projA", title: "use pnpm, not npm", kind: "convention" });
    const got = s.query({ scope: "personal", projectId: "projA" });
    expect(got.map((m) => m.title)).toEqual(["use pnpm, not npm"]);
    expect(got[0].scope).toBe("personal");
    expect(got[0].kind).toBe("convention");
  });

  it("isolates memories by project", () => {
    const s = store();
    s.write({ projectId: "projA", title: "A-note" });
    s.write({ projectId: "projB", title: "B-note" });
    expect(s.query({ projectId: "projA" }).map((m) => m.title)).toEqual(["A-note"]);
    expect(s.query({ projectId: "projB" }).map((m) => m.title)).toEqual(["B-note"]);
  });

  it("filters by scope", () => {
    const s = store();
    s.write({ scope: "personal", projectId: "p", title: "personal" });
    s.write({ scope: "collective", projectId: null, title: "collective" });
    expect(s.query({ scope: "collective" }).map((m) => m.title)).toEqual(["collective"]);
  });
});

describe("MemoryStore — ranking", () => {
  it("orders by salience, then recency", () => {
    const rows: Memory[] = [
      mk("low-old", { salience: 1, updatedAt: 100 }),
      mk("high", { salience: 5, updatedAt: 50 }),
      mk("low-new", { salience: 1, updatedAt: 200 }),
    ];
    expect(rankMemories(rows).map((m) => m.title)).toEqual(["high", "low-new", "low-old"]);
  });

  it("boosts text relevance above recency (but below salience)", () => {
    const rows: Memory[] = [
      mk("match", { salience: 1, updatedAt: 10, body: "worktree isolation" }),
      mk("newer-nomatch", { salience: 1, updatedAt: 999, body: "unrelated" }),
    ];
    expect(rankMemories(rows, "worktree")[0].title).toBe("match");
  });

  it("query text filters out non-matching rows", () => {
    const s = store();
    s.write({ projectId: "p", title: "about worktrees", body: "git worktree per agent" });
    s.write({ projectId: "p", title: "about themes", body: "solarized colors" });
    const got = s.query({ projectId: "p", text: "worktree" });
    expect(got.map((m) => m.title)).toEqual(["about worktrees"]);
  });
});

describe("MemoryStore — expiry (conscious layer)", () => {
  it("excludes and prunes expired rows on query", () => {
    const s = store();
    s.write({ scope: "conscious", projectId: "p", agentId: "a", title: "stale", ttlMs: -1 });
    s.write({ scope: "conscious", projectId: "p", agentId: "a", title: "fresh", ttlMs: 60_000 });
    const got = s.query({ projectId: "p" });
    expect(got.map((m) => m.title)).toEqual(["fresh"]);
    // The expired one is gone from the backend too.
    expect(s.query({ projectId: "p", includeExpired: true }).map((m) => m.title)).toEqual(["fresh"]);
  });

  it("permanent memories (no ttl) never expire", () => {
    const s = store();
    s.write({ projectId: "p", title: "forever" });
    expect(s.prune()).toBe(0);
    expect(s.query({ projectId: "p" })).toHaveLength(1);
  });
});

describe("MemoryStore — reinforce + delete", () => {
  it("reinforce raises salience so it ranks higher", () => {
    const s = store();
    s.write({ projectId: "p", title: "x", salience: 0 });
    const y = s.write({ projectId: "p", title: "y", salience: 0 });
    s.reinforce(y.id, 3);
    expect(s.query({ projectId: "p" })[0].title).toBe("y");
  });

  it("delete removes a memory", () => {
    const s = store();
    const m = s.write({ projectId: "p", title: "gone" });
    s.delete(m.id);
    expect(s.query({ projectId: "p" })).toHaveLength(0);
  });
});

// --- helper -----------------------------------------------------------------
function mk(title: string, over: Partial<Memory>): Memory {
  return {
    id: "mem-" + title,
    scope: "personal",
    projectId: "p",
    agentId: null,
    kind: "note",
    title,
    body: "",
    tags: [],
    salience: 0,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: null,
    ...over,
  };
}
