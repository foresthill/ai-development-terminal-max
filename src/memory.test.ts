import { describe, it, expect } from "vitest";
import {
  MemoryStore,
  rankMemories,
  memoriesToJson,
  memoriesFromJson,
  memoriesToMarkdown,
  type Memory,
  type MemoryBackend,
} from "./memory";

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

describe("MemoryStore — upsert (stable id, e.g. a Claude session)", () => {
  it("inserts once, then updates in place on the same id (no duplicate)", () => {
    const s = store();
    s.upsert("claude-session-abc", {
      scope: "collective",
      kind: "summary",
      title: "first title",
      body: '{"messages":3}',
      salience: 3,
    });
    s.upsert("claude-session-abc", {
      scope: "collective",
      kind: "summary",
      title: "grew",
      body: '{"messages":9}',
      salience: 9,
    });
    const rows = s.query({ scope: "collective", limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("claude-session-abc");
    expect(rows[0].title).toBe("grew");
    expect(rows[0].body).toBe('{"messages":9}');
    expect(rows[0].salience).toBe(9);
  });

  it("keeps createdAt but advances updatedAt across upserts", async () => {
    const s = store();
    const a = s.upsert("sid", { title: "v1" });
    await new Promise((r) => setTimeout(r, 2));
    const b = s.upsert("sid", { title: "v2" });
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
  });
});

describe("portable import/export (no lock-in)", () => {
  it("JSON round-trips losslessly", () => {
    const s = store();
    s.write({ projectId: "p", title: "keep pnpm", body: "v10", kind: "convention", tags: ["build"], salience: 3 });
    s.write({ projectId: "p", title: "ship weekly", kind: "goal" });
    const json = memoriesToJson(s.query({ projectId: "p" }));
    const back = memoriesFromJson(json);
    expect(back).toHaveLength(2);
    const conv = back.find((m) => m.title === "keep pnpm")!;
    expect(conv.kind).toBe("convention");
    expect(conv.tags).toEqual(["build"]);
    expect(conv.salience).toBe(3);
  });

  it("importMany de-duplicates by id", () => {
    const s1 = store();
    const m = s1.write({ projectId: "p", title: "x" });
    const exported = memoriesFromJson(memoriesToJson([m]));
    const s2 = store();
    expect(s2.importMany(exported)).toBe(1); // new
    expect(s2.importMany(exported)).toBe(0); // same id, skipped
    expect(s2.query({ projectId: "p" })).toHaveLength(1);
  });

  it("markdown export contains titles and bodies", () => {
    const md = memoriesToMarkdown([mk("design rule", { body: "worktree per agent" })], "proj");
    expect(md).toContain("# proj");
    expect(md).toContain("## design rule");
    expect(md).toContain("worktree per agent");
  });

  it("fromJson drops malformed rows but keeps valid ones", () => {
    const text = JSON.stringify([{ nope: 1 }, { title: "good" }, { title: "" }]);
    const rows = memoriesFromJson(text);
    expect(rows.map((m) => m.title)).toEqual(["good"]);
  });

  it("fromJson throws only on non-array JSON", () => {
    expect(() => memoriesFromJson("{}")).toThrow();
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
