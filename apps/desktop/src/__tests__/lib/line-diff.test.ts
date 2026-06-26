import { describe, it, expect } from "vitest";
import { lineDiff, diffStats } from "@/lib/line-diff";

describe("lineDiff", () => {
  it("marks a changed line as a del followed by an add, keeping context", () => {
    const out = lineDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  it("detects pure insertions and deletions", () => {
    expect(lineDiff("a\nc\n", "a\nb\nc\n")).toEqual([
      { type: "context", text: "a" },
      { type: "add", text: "b" },
      { type: "context", text: "c" },
    ]);
    expect(lineDiff("a\nb\nc\n", "a\nc\n")).toEqual([
      { type: "context", text: "a" },
      { type: "del", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("ignores a trailing newline (no spurious blank line)", () => {
    expect(lineDiff("a\n", "a\n")).toEqual([{ type: "context", text: "a" }]);
  });

  it("summarizes added/removed counts", () => {
    const out = lineDiff("a\nb\n", "a\nB\nc\n");
    expect(diffStats(out)).toEqual({ added: 2, removed: 1 });
  });
});
