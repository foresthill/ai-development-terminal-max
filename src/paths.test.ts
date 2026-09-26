import { describe, it, expect } from "vitest";
import { findPathSpans } from "./paths";

// Helper: just the matched strings, in the order findPathSpans returns them.
const raws = (text: string) => findPathSpans(text).map((s) => s.raw);

describe("findPathSpans", () => {
  it("matches a bare absolute path that contains spaces (whole-line)", () => {
    const p =
      "/Users/foresthill/Documents/Obsidian Vault/Active/Work/IGREK/TTBS/kintoneプロジェクト/受領資料/20260827_山下さん共有/";
    expect(raws(p)).toEqual([p]);
  });

  it("matches a ~ home path with spaces (whole-line)", () => {
    const p = "~/Documents/My Notes/todo.md";
    expect(raws(p)).toEqual([p]);
  });

  it("matches inline file paths with :line and relative files", () => {
    expect(raws("see src/app.ts:42 and docs/x/foo.md")).toEqual([
      "src/app.ts:42",
      "docs/x/foo.md",
    ]);
  });

  it("matches trailing-slash directories", () => {
    expect(raws("the dir src/components/ holds it")).toEqual(["src/components/"]);
    expect(raws("open /usr/local/bin/ now")).toEqual(["/usr/local/bin/"]);
  });

  it("does NOT match mid-word slashes in prose", () => {
    expect(raws("read/write and and/or or TCP/IP protocols")).toEqual([]);
  });

  it("matches a quoted rooted path with spaces (inner text only)", () => {
    const spans = findPathSpans('edit "/Users/foo bar/notes.md" please');
    expect(spans.map((s) => s.raw)).toContain("/Users/foo bar/notes.md");
    // the span excludes the surrounding quotes
    const q = spans.find((s) => s.raw === "/Users/foo bar/notes.md")!;
    expect(q.start).toBe('edit "'.length);
  });

  it("matches Japanese relative file paths", () => {
    expect(raws("成果物/_社内検討/メール_土井さん.md")).toEqual([
      "成果物/_社内検討/メール_土井さん.md",
    ]);
  });

  it("matches ./ relative paths", () => {
    expect(raws("run ./scripts/build.sh now")).toEqual(["./scripts/build.sh"]);
  });

  it("does NOT claim a slice inside a URL", () => {
    // the `com/agent.md` inside the URL must not become a separate path link
    expect(raws("visit https://example.com/agent.md today")).toEqual([]);
  });

  it("matches an absolute file mentioned mid-sentence", () => {
    expect(raws("a path /Users/foresthill/Documents/report.pdf here")).toEqual([
      "/Users/foresthill/Documents/report.pdf",
    ]);
  });

  it("returns nothing for plain prose", () => {
    expect(raws("nothing to see here.")).toEqual([]);
    expect(raws("")).toEqual([]);
  });

  it("keeps spans non-overlapping", () => {
    const spans = findPathSpans("see src/app.ts:42 and docs/x/foo.md");
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });
});
