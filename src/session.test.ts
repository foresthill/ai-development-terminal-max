import { describe, it, expect } from "vitest";
import { currentSessionId, sessionTag, sessionIdFromTags, sessionStartedAt } from "./session";

describe("session model", () => {
  it("has a stable id for the launch and a session: tag", () => {
    const id = currentSessionId();
    expect(id).toMatch(/^sess-[0-9a-z]+-[0-9a-z]+$/);
    expect(sessionTag()).toBe(`session:${id}`);
    expect(sessionTag("sess-abc-de")).toBe("session:sess-abc-de");
  });

  it("extracts the session id from tags (or null)", () => {
    expect(sessionIdFromTags(["build", "session:sess-x-y", "k"])).toBe("sess-x-y");
    expect(sessionIdFromTags(["build", "other"])).toBeNull();
    expect(sessionIdFromTags([])).toBeNull();
  });

  it("recovers the start time encoded in the id", () => {
    const now = Date.now();
    const id = `sess-${now.toString(36)}-abcd`;
    const got = sessionStartedAt(id);
    expect(got).toBe(now);
  });

  it("returns null for a malformed / foreign session id", () => {
    expect(sessionStartedAt("imported-tag")).toBeNull();
    expect(sessionStartedAt("sess--x")).toBeNull();
  });

  it("round-trips the current session through tag + extract + time", () => {
    const id = currentSessionId();
    const extracted = sessionIdFromTags([sessionTag()]);
    expect(extracted).toBe(id);
    expect(sessionStartedAt(id)).toBeGreaterThan(0);
  });
});
