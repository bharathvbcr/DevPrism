/**
 * Byte-budgeted LRU cache of rendered PDF page bitmaps.
 *
 * Rasterizing a page through the MuPDF worker at supersampled DPI costs tens
 * of milliseconds plus worker round trips; zoom settles and visibility
 * restores were paying that repeatedly for identical renders. Keeping the last
 * N pages' `ImageBitmap`s turns those into a canvas blit.
 *
 * Budgeted by decoded pixel bytes (width*height*4), not entry count, because a
 * single A4 page at render DPI is already several MB.
 */

/** ~160 MB of decoded pixels (~20 A4 pages at 144 DPI). */
export const MAX_PAGE_BITMAP_BYTES = 160 * 1024 * 1024;

interface Entry {
  bitmap: ImageBitmap;
  bytes: number;
}

// Map iteration order = recency (least recent first).
const cache = new Map<string, Entry>();

let totalBytes = 0;

export function pageBitmapKey(
  docId: number,
  pageIndex: number,
  dpi: number,
): string {
  // Round DPI so sub-pixel scale jitter doesn't defeat reuse.
  return `${docId}:${pageIndex}:${Math.round(dpi)}`;
}

function evictToFit(): void {
  while (totalBytes > MAX_PAGE_BITMAP_BYTES && cache.size > 1) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const entry = cache.get(oldestKey)!;
    cache.delete(oldestKey);
    totalBytes -= entry.bytes;
    entry.bitmap.close();
  }
}

export function getPageBitmap(
  docId: number,
  pageIndex: number,
  dpi: number,
): ImageBitmap | null {
  const key = pageBitmapKey(docId, pageIndex, dpi);
  const entry = cache.get(key);
  if (!entry) return null;
  // Bump recency.
  cache.delete(key);
  cache.set(key, entry);
  return entry.bitmap;
}

/** Takes ownership of `bitmap` — do not close it after putting. */
export function putPageBitmap(
  docId: number,
  pageIndex: number,
  dpi: number,
  bitmap: ImageBitmap,
): void {
  const key = pageBitmapKey(docId, pageIndex, dpi);
  const existing = cache.get(key);
  if (existing) {
    if (existing.bitmap !== bitmap) existing.bitmap.close();
    totalBytes -= existing.bytes;
    cache.delete(key);
  }
  const bytes = bitmap.width * bitmap.height * 4;
  cache.set(key, { bitmap, bytes });
  totalBytes += bytes;
  evictToFit();
}

export function clearPageBitmaps(docId?: number): void {
  if (docId === undefined) {
    for (const entry of cache.values()) entry.bitmap.close();
    cache.clear();
    totalBytes = 0;
    return;
  }
  const prefix = `${docId}:`;
  for (const [key, entry] of [...cache.entries()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      totalBytes -= entry.bytes;
      entry.bitmap.close();
    }
  }
}

/** Test-only: current byte usage of the cache. */
export function pageBitmapCacheBytesForTest(): number {
  return totalBytes;
}
