import { describe, it, expect } from "vitest";
import { toDisplayDiffRows } from "@/lib/diff-display";
import { lineDiff } from "@/lib/line-diff";

describe("toDisplayDiffRows", () => {
  it("merges single-line del+add pairs into word rows", () => {
    const rows = toDisplayDiffRows(lineDiff("alpha\nbeta\n", "alpha\nBETA\n"));
    expect(rows).toEqual([
      { kind: "context", text: "alpha" },
      { kind: "word", oldText: "beta", newText: "BETA" },
    ]);
  });

  it("keeps separate rows for multi-line insertions", () => {
    const rows = toDisplayDiffRows(lineDiff("a\n", "a\nb\nc\n"));
    expect(rows).toEqual([
      { kind: "context", text: "a" },
      { kind: "add", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("does NOT word-pair across a multi-line changed block (pass-2 #5)", () => {
    // lineDiff('X1\nX2','Y1\nY2') => [del X1, del X2, add Y1, add Y2].
    // The last del must not be word-paired with the first add.
    const rows = toDisplayDiffRows(lineDiff("X1\nX2\n", "Y1\nY2\n"));
    expect(rows).toEqual([
      { kind: "del", text: "X1" },
      { kind: "del", text: "X2" },
      { kind: "add", text: "Y1" },
      { kind: "add", text: "Y2" },
    ]);
    expect(rows.some((r) => r.kind === "word")).toBe(false);
  });

  it("still word-pairs a genuine lone 1:1 change", () => {
    const rows = toDisplayDiffRows(lineDiff("a\nX\nb\n", "a\nY\nb\n"));
    expect(rows).toEqual([
      { kind: "context", text: "a" },
      { kind: "word", oldText: "X", newText: "Y" },
      { kind: "context", text: "b" },
    ]);
  });
});
