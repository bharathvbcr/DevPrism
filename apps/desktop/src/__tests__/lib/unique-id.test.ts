import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nextSequence,
  resetSequenceForTests,
  scratchSuffix,
  uniqueId,
  uniqueToken,
} from "@/lib/unique-id";

afterEach(() => {
  vi.unstubAllGlobals();
  resetSequenceForTests();
});

describe("nextSequence", () => {
  it("is strictly increasing", () => {
    resetSequenceForTests();
    const values = Array.from({ length: 1000 }, () => nextSequence());
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it("never repeats, even called in the same millisecond", () => {
    // The exact failure mode of `Date.now()` this replaces.
    resetSequenceForTests();
    const now = Date.now();
    const values = new Set(Array.from({ length: 5000 }, () => nextSequence()));
    expect(values.size).toBe(5000);
    // Sanity: the loop really did run inside a tight window.
    expect(Date.now() - now).toBeLessThan(2000);
  });
});

describe("uniqueToken", () => {
  it("produces distinct filename-safe tokens", () => {
    const tokens = Array.from({ length: 2000 }, () => uniqueToken());
    expect(new Set(tokens).size).toBe(2000);
    for (const t of tokens) {
      expect(t).toMatch(/^[a-z0-9]+$/);
      expect(t.length).toBeGreaterThanOrEqual(8);
    }
  });

  it("falls back to getRandomValues when randomUUID is missing", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: real.getRandomValues.bind(real),
    });
    const tokens = Array.from({ length: 500 }, () => uniqueToken());
    expect(new Set(tokens).size).toBe(500);
    expect(tokens[0]).toMatch(/^[a-f0-9]{16}$/);
  });

  it("still yields distinct values with no Web Crypto at all", () => {
    resetSequenceForTests();
    vi.stubGlobal("crypto", undefined);
    const tokens = Array.from({ length: 500 }, () => uniqueToken());
    expect(new Set(tokens).size).toBe(500);
    expect(tokens[0]).toMatch(/^[a-z0-9]+$/);
  });
});

describe("uniqueId", () => {
  it("never repeats for the same prefix", () => {
    const ids = Array.from({ length: 2000 }, () => uniqueId("paste"));
    expect(new Set(ids).size).toBe(2000);
    for (const id of ids) expect(id.startsWith("paste-")).toBe(true);
  });

  it("keeps the prefix readable for debugging", () => {
    expect(uniqueId("paste")).toMatch(/^paste-[a-z0-9]+$/);
  });
});

describe("knowledge-base source URIs", () => {
  it("stays unique when two pastes land in the same millisecond", () => {
    // These URIs are persisted identity for a kb_source row; a duplicate would
    // overwrite the earlier paste instead of creating a second source.
    const uris = Array.from(
      { length: 500 },
      () => `paste://markdown-${scratchSuffix(1700000000000)}`,
    );
    expect(new Set(uris).size).toBe(500);
  });

  it("produces a well-formed uri", () => {
    expect(`paste://bibtex-${scratchSuffix()}`).toMatch(
      /^paste:\/\/bibtex-[0-9]+-[a-z0-9]+$/,
    );
  });
});

describe("scratchSuffix", () => {
  it("is unique even when the clock does not advance", () => {
    // Pin the timestamp so uniqueness can only come from the token — exactly
    // the two-previews-in-one-millisecond case.
    const suffixes = Array.from({ length: 1000 }, () =>
      scratchSuffix(1700000000000),
    );
    expect(new Set(suffixes).size).toBe(1000);
  });

  it("keeps the timestamp prefix so leftovers stay identifiable", () => {
    expect(scratchSuffix(1700000000000)).toMatch(/^1700000000000-[a-z0-9]+$/);
  });

  it("produces a value safe to embed in a filename", () => {
    const name = `.devprism-track-changes-preview-${scratchSuffix()}.tex`;
    expect(name).toMatch(
      /^\.devprism-track-changes-preview-[0-9]+-[a-z0-9]+\.tex$/,
    );
    // No path separators or shell-significant characters.
    expect(name).not.toMatch(/[/\\:*?"<>|\s]/);
  });
});
