import { describe, it, expect } from "vitest";
import { skillInvocation, type SkillInfo } from "./skills";

function sk(over: Partial<SkillInfo>): SkillInfo {
  return {
    name: "review",
    description: "",
    source: "project",
    plugin: "",
    path: "/x/.claude/skills/review/SKILL.md",
    ...over,
  };
}

describe("skillInvocation — the exact slash form a person types", () => {
  it("project skills are /<name>", () => {
    expect(skillInvocation(sk({ source: "project", name: "init" }))).toBe("/init");
  });

  it("personal skills are /<name>", () => {
    expect(skillInvocation(sk({ source: "user", name: "code-review" }))).toBe("/code-review");
  });

  it("plugin skills are namespaced /<plugin>:<name>", () => {
    expect(skillInvocation(sk({ source: "plugin", plugin: "my-plugin", name: "review" }))).toBe(
      "/my-plugin:review",
    );
  });

  it("a plugin skill with no plugin name falls back to /<name>", () => {
    expect(skillInvocation(sk({ source: "plugin", plugin: "", name: "review" }))).toBe("/review");
  });
});
