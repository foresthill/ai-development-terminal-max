import { describe, it, expect } from "vitest";
import { distill } from "./distill";
import type { SessionDigest } from "./claude-sessions";

function s(over: Partial<SessionDigest>): SessionDigest {
  return {
    sessionId: Math.random().toString(36).slice(2),
    cwd: "/x",
    project: "proj",
    gitBranch: "main",
    slug: "slug",
    title: "",
    firstTs: "2026-11-01T00:00:00Z",
    lastTs: "2026-11-02T00:00:00Z",
    messages: 0,
    ...over,
  };
}

describe("distill — heuristic learning over sessions", () => {
  it("aggregates per-project counts, messages and unique branches", () => {
    const ins = distill([
      s({ project: "a", gitBranch: "main", messages: 10 }),
      s({ project: "a", gitBranch: "feature/x", messages: 5 }),
      s({ project: "b", gitBranch: "main", messages: 3 }),
    ]);
    const a = ins.projects.find((p) => p.project === "a")!;
    expect(a.sessions).toBe(2);
    expect(a.messages).toBe(15);
    expect(a.branches.sort()).toEqual(["feature/x", "main"]);
    expect(ins.global.sessions).toBe(3);
    expect(ins.global.messages).toBe(18);
    expect(ins.global.projects).toBe(2);
  });

  it("ranks busiest projects by session count", () => {
    const ins = distill([
      s({ project: "busy" }),
      s({ project: "busy" }),
      s({ project: "quiet" }),
    ]);
    expect(ins.global.busiest[0]).toEqual({ project: "busy", sessions: 2 });
  });

  it("surfaces title topics that recur across >=2 sessions, dropping stop-words", () => {
    const ins = distill([
      s({ title: "Fix the flaky integration test" }),
      s({ title: "Another flaky test on CI" }),
      s({ title: "unrelated work" }),
    ]);
    const terms = ins.global.topics.map((t) => t.term);
    expect(terms).toContain("flaky");
    expect(terms).toContain("test");
    // stop-words and singletons excluded
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("unrelated");
  });

  it("spans activity from earliest first to latest last", () => {
    const ins = distill([
      s({ project: "a", firstTs: "2026-11-05T00:00:00Z", lastTs: "2026-11-06T00:00:00Z" }),
      s({ project: "a", firstTs: "2026-11-01T00:00:00Z", lastTs: "2026-11-02T00:00:00Z" }),
    ]);
    const a = ins.projects[0];
    expect(a.firstTs).toBe("2026-11-01T00:00:00Z");
    expect(a.lastTs).toBe("2026-11-06T00:00:00Z");
  });

  it("empty input yields a zeroed global and no projects", () => {
    const ins = distill([]);
    expect(ins.global.sessions).toBe(0);
    expect(ins.projects).toHaveLength(0);
  });
});
