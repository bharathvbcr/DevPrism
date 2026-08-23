import { describe, expect, it } from "vitest";
import type { KbChunkRow } from "@/lib/career";
import {
  chunkHeadingLabel,
  matchesChunkFilter,
  sortKbChunksForDisplay,
  stripHeadingPrefix,
} from "@/lib/career/kb-source-view";

function row(
  id: string,
  text: string,
  meta?: unknown,
  hasEmbedding = true,
): KbChunkRow {
  return { id, sourceId: "src_1", text, meta, hasEmbedding };
}

function shuffledIds(): string[] {
  // Deterministic pseudo-random UUID-like ids (backend orders by id ASC).
  return Array.from(
    { length: 8 },
    (_, i) =>
      `chk_${((i * 2654435761) % 0xffffffff).toString(16).padStart(8, "0")}a1b2c3d4e5f6`,
  );
}

describe("sortKbChunksForDisplay", () => {
  it("orders chunks by meta.index even when backend ids scramble arrival order", () => {
    const ids = shuffledIds();
    const rows = [4, 0, 7, 2, 6, 1, 5, 3].map(
      (idx, i) => row(ids[i], `text-${idx}`, { index: idx }), // arrival order ≠ index
    );
    const sorted = sortKbChunksForDisplay(rows);
    expect(sorted.map((r) => r.text)).toEqual([
      "text-0",
      "text-1",
      "text-2",
      "text-3",
      "text-4",
      "text-5",
      "text-6",
      "text-7",
    ]);
  });

  it("is stable for duplicate indexes", () => {
    const rows = [
      row("a", "first", { index: 1 }),
      row("b", "second", { index: 1 }),
      row("c", "third", { index: 0 }),
      row("d", "fourth", { index: 1 }),
    ];
    const sorted = sortKbChunksForDisplay(rows);
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("keeps malformed-meta chunks at the end in arrival order", () => {
    const rows = [
      row("late1", "null meta", null),
      row("mid", "indexed", { index: 3 }),
      row("late2", "string index", { index: "9" }),
      row("early", "indexed", { index: 1 }),
      row("late3", "nan index", { index: Number.NaN }),
      row("late4", "no meta key", {}),
      row("late5", "array meta", ["index"]),
      row("early2", "indexed", { index: -5 }),
    ];
    const sorted = sortKbChunksForDisplay(rows);
    expect(sorted.map((r) => r.id)).toEqual([
      "early2",
      "early",
      "mid",
      "late1",
      "late2",
      "late3",
      "late4",
      "late5",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [row("b", "two", { index: 2 }), row("a", "one", { index: 1 })];
    const snapshot = [...rows];
    sortKbChunksForDisplay(rows);
    expect(rows.map((r) => r.id)).toEqual(snapshot.map((r) => r.id));
  });

  it("survives a large shuffled corpus (stress)", () => {
    const n = 5000;
    const rows = Array.from({ length: n }, (_, i) =>
      row(`chk_${(i * 7919) % n}`.padEnd(20, "x"), `t${i}`, {
        index: (i * 7919) % n,
      }),
    );
    const sorted = sortKbChunksForDisplay(rows);
    expect(sorted).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      const meta = sorted[i]!.meta as { index: number };
      expect(meta.index).toBe(i);
    }
  });

  it("handles empty input", () => {
    expect(sortKbChunksForDisplay([])).toEqual([]);
  });
});

describe("chunkHeadingLabel", () => {
  it("joins a clean heading path", () => {
    expect(chunkHeadingLabel({ headingPath: ["Projects", "DevPrism"] })).toBe(
      "Projects > DevPrism",
    );
  });

  it("trims and drops empty/whitespace segments", () => {
    expect(chunkHeadingLabel({ headingPath: ["  A ", "", "B"] })).toBe("A > B");
  });

  it("tolerates malformed metas", () => {
    expect(chunkHeadingLabel(null)).toBe("");
    expect(chunkHeadingLabel(undefined)).toBe("");
    expect(chunkHeadingLabel("nope")).toBe("");
    expect(chunkHeadingLabel({})).toBe("");
    expect(chunkHeadingLabel({ headingPath: "not-an-array" })).toBe("");
    expect(chunkHeadingLabel({ headingPath: [1, null, "ok"] })).toBe("ok");
  });
});

describe("stripHeadingPrefix", () => {
  it("removes exactly the duplicated heading line", () => {
    expect(
      stripHeadingPrefix(
        "Projects > DevPrism\n\nBody here",
        "Projects > DevPrism",
      ),
    ).toBe("Body here");
  });

  it("leaves text untouched when the label does not prefix it", () => {
    expect(stripHeadingPrefix("Unrelated\nbody", "Projects")).toBe(
      "Unrelated\nbody",
    );
  });

  it("no-ops without a label", () => {
    expect(stripHeadingPrefix("# Heading\n\ntext", "")).toBe(
      "# Heading\n\ntext",
    );
  });
});

describe("matchesChunkFilter", () => {
  const chunk = row("a", "DevPrism ingests markdown sources", {
    headingPath: ["Pipeline", "Chunking"],
  });

  it("matches case-insensitively across text and headings", () => {
    expect(matchesChunkFilter(chunk, "devprism")).toBe(true);
    expect(matchesChunkFilter(chunk, "CHUNKING")).toBe(true);
    expect(matchesChunkFilter(chunk, "pipeline > chunking")).toBe(true);
  });

  it("rejects non-matching queries and ignores blank queries", () => {
    expect(matchesChunkFilter(chunk, "quantum")).toBe(false);
    expect(matchesChunkFilter(chunk, "   ")).toBe(true);
    expect(matchesChunkFilter(chunk, "")).toBe(true);
  });
});
