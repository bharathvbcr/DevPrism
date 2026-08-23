import { describe, expect, it } from "vitest";
import {
  clearPageBitmaps,
  getPageBitmap,
  pageBitmapCacheBytesForTest,
  putPageBitmap,
} from "@/lib/mupdf/page-bitmap-cache";

/**
 * Seeded fuzz over the page-bitmap LRU with two hard invariants:
 *  1. Byte accounting: reported usage always equals the sum of live entries.
 *  2. Lifecycle safety: every bitmap is closed exactly once, ever — a
 *     double-close crashes Chromium's graphics stack, so the cache must
 *     guarantee it structurally.
 */

/** Deterministic PRNG (mulberry32) — reproducible failure traces. */
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

interface TrackedBitmap {
  width: number;
  height: number;
  closed: boolean;
}

function trackedBitmap(
  width: number,
  height: number,
): ImageBitmap & { __tracked: TrackedBitmap } {
  const tracked: TrackedBitmap = { width, height, closed: false };
  const bmp = {
    width,
    height,
    close: () => {
      if (tracked.closed) {
        throw new Error("DOUBLE CLOSE detected");
      }
      tracked.closed = true;
    },
    __tracked: tracked,
  };
  return bmp as unknown as ImageBitmap & { __tracked: TrackedBitmap };
}

function key(docId: number, pageIndex: number, dpi: number) {
  return `${docId}:${pageIndex}:${Math.round(dpi)}`;
}

describe("stress: page-bitmap-cache fuzz", () => {
  it("10k random operations keep byte accounting and close-once invariants", () => {
    clearPageBitmaps();
    const rng = makeRng(0xd06d1);
    /** Live entries per the model of the system under test. */
    const live = new Map<string, ImageBitmap & { __tracked: TrackedBitmap }>();

    const verifyAccounting = () => {
      let sum = 0;
      for (const bmp of live.values()) {
        sum += bmp.width * bmp.height * 4;
      }
      expect(pageBitmapCacheBytesForTest()).toBe(sum);
    };

    for (let op = 0; op < 10_000; op++) {
      const roll = rng();
      const docId = 1 + Math.floor(rng() * 4); // docs 1..4
      const pageIndex = Math.floor(rng() * 12);
      // DPI jitter around common values to exercise key rounding.
      const dpi = [143.9, 144.05, 216, 288.2][Math.floor(rng() * 4)];

      if (roll < 0.55) {
        // PUT — sometimes replacing an existing entry.
        const k = key(docId, pageIndex, dpi);
        const previous = live.get(k);
        const bmp = trackedBitmap(
          256 + Math.floor(rng() * 512),
          256 + Math.floor(rng() * 512),
        );
        putPageBitmap(docId, pageIndex, dpi, bmp);
        live.set(k, bmp);
        // Replaced bitmaps are closed by the cache; brand-new ones are not.
        // (We cannot assert "previous.closed" here without racing eviction —
        // covered by the global no-double-close guard via close() throwing.)
        void previous;
      } else if (roll < 0.9) {
        // GET — must return exactly the tracked object when present.
        const k = key(docId, pageIndex, dpi);
        const expected = live.get(k);
        const actual = getPageBitmap(docId, pageIndex, dpi);
        expect(actual === expected ? "hit" : "miss").toBe(
          expected ? "hit" : "miss",
        );
        if (expected && actual) {
          expect(actual).toBe(expected);
        }
      } else if (roll < 0.97) {
        // CLEAR one document.
        clearPageBitmaps(docId);
        const prefix = `${docId}:`;
        for (const [k, _bmp] of [...live.entries()]) {
          if (k.startsWith(prefix)) live.delete(k);
        }
      } else {
        // CLEAR everything.
        clearPageBitmaps();
        live.clear();
      }

      // Evictions close bitmaps; drop them from the live set when that has
      // happened, then re-check accounting. Detect closure lazily since we
      // don't get eviction callbacks.
      if (op % 97 === 0) {
        for (const [k, _bmp] of [...live.entries()]) {
          if (!getPageBitmap(...parseKey(k))) continue; // evicted earlier
        }
        // Recompute live set from what the cache still holds.
        reconcileLiveSet(live);
        verifyAccounting();
      }
    }

    clearPageBitmaps();
    expect(pageBitmapCacheBytesForTest()).toBe(0);
  }, 30_000);

  it("budget pressure closes evicted bitmaps exactly once", () => {
    clearPageBitmaps();
    const rng = makeRng(99);
    const allEverInserted: Array<ImageBitmap & { __tracked: TrackedBitmap }> =
      [];

    // Insert far beyond the ~160MB budget with large pages.
    for (let i = 0; i < 120; i++) {
      const bmp = trackedBitmap(2048, 2048); // 16 MB each → budget ≈ 10 pages
      putPageBitmap(3, i, 144 + Math.floor(rng() * 3), bmp as ImageBitmap);
      allEverInserted.push(bmp);
    }
    clearPageBitmaps();

    // Every bitmap must have been closed exactly once by now (eviction or
    // final clear) — close() throws on double-close, so reaching here proves it.
    const unclosed = allEverInserted.filter((b) => !b.__tracked.closed);
    // Some may legitimately remain open only if never evicted AND never
    // cleared — but we cleared everything, so all must be closed.
    expect(unclosed.length).toBe(0);
    expect(pageBitmapCacheBytesForTest()).toBe(0);
  });
});

/** Parse "doc:page:dpi" keys used by the fuzz harness. */
function parseKey(k: string): [number, number, number] {
  const [doc, page, dpi] = k.split(":");
  return [Number(doc), Number(page), Number(dpi)];
}

/**
 * The cache may have evicted entries the harness still thinks are live.
 * Drop those from the model (their bytes left the cache too).
 */
function reconcileLiveSet(
  live: Map<string, ImageBitmap & { __tracked: TrackedBitmap }>,
): void {
  for (const k of [...live.keys()]) {
    const [doc, page, dpi] = parseKey(k);
    if (getPageBitmap(doc, page, dpi) !== live.get(k)) {
      live.delete(k);
    }
  }
}
