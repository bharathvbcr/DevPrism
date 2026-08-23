import { describe, expect, it } from "vitest";
import {
  clearPageBitmaps,
  getPageBitmap,
  pageBitmapCacheBytesForTest,
  putPageBitmap,
} from "@/lib/mupdf/page-bitmap-cache";

function fakeBitmap(width: number, height: number): ImageBitmap {
  return {
    width,
    height,
    close: () => {},
  } as unknown as ImageBitmap;
}

/** 1 MB per bitmap (512x512x4). */
const MB = 512 * 512 * 4;

describe("page-bitmap-cache", () => {
  it("returns null on miss and the bitmap on hit", () => {
    clearPageBitmaps();
    const bmp = fakeBitmap(512, 512);
    expect(getPageBitmap(1, 0, 144)).toBeNull();
    putPageBitmap(1, 0, 144, bmp);
    expect(getPageBitmap(1, 0, 144)).toBe(bmp);
    // Different dpi → different key.
    expect(getPageBitmap(1, 0, 145)).toBeNull();
    clearPageBitmaps();
  });

  it("rounds dpi so sub-pixel jitter reuses entries", () => {
    clearPageBitmaps();
    const bmp = fakeBitmap(512, 512);
    putPageBitmap(1, 3, 143.98, bmp);
    expect(getPageBitmap(1, 3, 144.02)).toBe(bmp);
    clearPageBitmaps();
  });

  it("evicts least-recently-used entries beyond the byte budget", () => {
    clearPageBitmaps();
    // Cache budget is 160 MB; insert 200 distinct pages worth of 1 MB
    // bitmaps and confirm the oldest are gone while recent ones remain.
    for (let i = 0; i < 200; i++) {
      putPageBitmap(7, i, 144, fakeBitmap(512, 512));
    }
    expect(pageBitmapCacheBytesForTest()).toBeLessThanOrEqual(
      160 * 1024 * 1024,
    );
    // Oldest pages were evicted.
    expect(getPageBitmap(7, 0, 144)).toBeNull();
    // Most recent pages remain (at least the last 40).
    let retained = 0;
    for (let i = 160; i < 200; i++) {
      if (getPageBitmap(7, i, 144) !== null) retained++;
    }
    expect(retained).toBe(40);
    clearPageBitmaps();
    expect(pageBitmapCacheBytesForTest()).toBe(0);
  });

  it("clearing a document frees only that document's bitmaps", () => {
    clearPageBitmaps();
    const keepBmp = fakeBitmap(512, 512);
    const dropBmp = fakeBitmap(512, 512);
    putPageBitmap(1, 0, 144, dropBmp);
    putPageBitmap(2, 0, 144, keepBmp);

    clearPageBitmaps(1);

    expect(getPageBitmap(1, 0, 144)).toBeNull();
    expect(pageBitmapCacheBytesForTest()).toBe(MB);
    expect(getPageBitmap(2, 0, 144)).toBe(keepBmp);
    clearPageBitmaps();
  });

  it("overwriting a key closes and replaces the previous bitmap", () => {
    clearPageBitmaps();
    const first = fakeBitmap(512, 512);
    let closed = false;
    const second = {
      width: 512,
      height: 512,
      close: () => {
        closed = true;
      },
    } as unknown as ImageBitmap;

    putPageBitmap(9, 9, 144, first);
    putPageBitmap(9, 9, 144, second);

    // Byte accounting must not double-count the replaced entry.
    expect(pageBitmapCacheBytesForTest()).toBe(MB);
    expect(getPageBitmap(9, 9, 144)).toBe(second);
    expect(closed).toBe(false); // second is still live in cache

    clearPageBitmaps();
    expect(closed).toBe(true);
  });
});
