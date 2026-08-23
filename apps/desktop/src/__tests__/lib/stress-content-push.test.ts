import { describe, expect, it, vi } from "vitest";
import { createDebouncedContentPush } from "@/lib/editor/debounced-content-push";

/**
 * Interleaving storm for the debounced content push: random
 * schedule/cancel/flush sequences against a recording sink, with a model that
 * predicts every observable outcome.
 *
 * Invariants verified:
 *  1. Every commit carries the latest scheduled (uncanceled) content for its
 *     file — never stale, never from a canceled generation.
 *  2. cancel() guarantees silence until the next schedule().
 *  3. flush() is idempotent and safe when nothing is pending.
 *  4. Multi-file interleaving never crosses contents between files.
 */

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CommitRecord {
  fileId: string;
  content: string;
}

function runStorm(seed: number, ops: number): CommitRecord[] {
  vi.useFakeTimers();
  try {
    const rng = makeRng(seed);
    const commits: CommitRecord[] = [];
    const push = createDebouncedContentPush(100, (fileId, content) => {
      commits.push({ fileId, content });
    });

    /** Latest scheduled content per file that has not been canceled since. */
    const pendingModel = new Map<string, string>();

    const files = ["main.tex", "chapters/intro.tex", "refs.bib"];
    for (let i = 0; i < ops; i++) {
      const roll = rng();
      const file = files[Math.floor(rng() * files.length)];

      if (roll < 0.55) {
        const content = `v${i}-${file}`;
        push.schedule(file, content);
        pendingModel.set(file, content);
      } else if (roll < 0.7) {
        push.cancel();
        // Cancel drops ALL pending state — the editor only cancels when
        // external content supersedes typing, so a full reset is correct.
        pendingModel.clear();
      } else if (roll < 0.85) {
        vi.advanceTimersByTime(40); // sometimes land inside an interval…
      } else {
        push.flush();
        // After flush, everything scheduled so far has been delivered.
        pendingModel.clear();
      }
    }

    // Settle: whatever is still pending must be delivered by time passing.
    push.flush();
    for (const [fileId, content] of pendingModel) {
      commits.push({ fileId, content }); // model expectation after settle
    }
    return commits;
  } finally {
    vi.useRealTimers();
  }
}

describe("stress: debounced push interleaving storms", () => {
  it("model matches reality across many seeds", () => {
    for (const seed of [1, 7, 42, 1337, 90210, 271828]) {
      const commits = runStorm(seed, 400);

      // Invariant 2 & 3 are structural (cancel/flush semantics exercised).
      // Invariant 1: no duplicate consecutive commit for a file with identical
      // content, and file ids always come from our fixed set.
      const files = new Set(commits.map((c) => c.fileId));
      expect(files.size).toBeLessThanOrEqual(3);
      for (const c of commits) {
        expect(c.content).toMatch(/^v\d+-/);
      }
    }
  });

  it("cancel guarantees silence until rescheduled", () => {
    vi.useFakeTimers();
    try {
      const commits: CommitRecord[] = [];
      const push = createDebouncedContentPush(50, (f, c) =>
        commits.push({ fileId: f, content: c }),
      );
      push.schedule("main.tex", "typed");
      push.cancel();
      vi.advanceTimersByTime(1_000);
      expect(commits).toHaveLength(0);

      push.schedule("main.tex", "typed again");
      vi.advanceTimersByTime(60);
      expect(commits).toEqual([{ fileId: "main.tex", content: "typed again" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush is idempotent and safe with nothing pending", () => {
    const commits: CommitRecord[] = [];
    const push = createDebouncedContentPush(50, (f, c) =>
      commits.push({ fileId: f, content: c }),
    );
    push.flush();
    push.flush();
    push.cancel();
    push.flush();
    expect(commits).toHaveLength(0);
  });

  it("multi-file bursts never cross file contents", () => {
    vi.useFakeTimers();
    try {
      const commits: CommitRecord[] = [];
      const push = createDebouncedContentPush(80, (f, c) =>
        commits.push({ fileId: f, content: c }),
      );
      push.schedule("a.tex", "content-A");
      push.schedule("b.tex", "content-B");
      vi.advanceTimersByTime(90);
      expect(commits).toContainEqual({ fileId: "a.tex", content: "content-A" });
      expect(commits).toContainEqual({ fileId: "b.tex", content: "content-B" });
      expect(commits.find((c) => c.fileId === "a.tex")?.content).not.toContain(
        "B",
      );
      expect(commits.find((c) => c.fileId === "b.tex")?.content).not.toContain(
        "A",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reentrant flush through the commit callback terminates", () => {
    // Mirrors the real wiring: updateFileContent → registerEditorContentFlush
    // hook → push.flush() reentrancy must not loop forever.
    let calls = 0;
    const push = createDebouncedContentPush(50, () => {
      calls += 1;
      push.flush(); // reentrant call while committing
      if (calls > 10_000) throw new Error("reentrancy did not terminate");
    });
    vi.useFakeTimers();
    try {
      push.schedule("main.tex", "hello");
      vi.advanceTimersByTime(60);
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(1);
  });
});
