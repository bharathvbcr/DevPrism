/** Pure helpers for viewing KB source contents (document-order chunk lists). */

import type { KbChunkRow } from "./types";

/**
 * Chunks come back from `career_list_kb_chunks` ordered by id, and ids are
 * random UUIDs — document order lives in `meta.index`. Sort stably by index;
 * rows without a usable numeric index keep their arrival order at the end.
 */
export function sortKbChunksForDisplay(
  chunks: readonly KbChunkRow[],
): KbChunkRow[] {
  const indexed: Array<{ row: KbChunkRow; key: number | null }> = chunks.map(
    (row) => ({ row, key: chunkIndex(row.meta) }),
  );
  const withKey = indexed
    .filter((e): e is { row: KbChunkRow; key: number } => e.key != null)
    .sort((a, b) => a.key - b.key);
  const without = indexed.filter((e) => e.key == null);
  return [...withKey.map((e) => e.row), ...without.map((e) => e.row)];
}

function chunkIndex(meta: unknown): number | null {
  if (meta == null || typeof meta !== "object") return null;
  const raw = (meta as { index?: unknown }).index;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw;
}

/** Breadcrumb label like "Projects > DevPrism", tolerant of malformed meta. */
export function chunkHeadingLabel(meta: unknown): string {
  if (meta == null || typeof meta !== "object") return "";
  const path = (meta as { headingPath?: unknown }).headingPath;
  if (!Array.isArray(path)) return "";
  return path
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" > ");
}

/**
 * The chunker prepends the heading breadcrumb as the first line of chunk text
 * (see formatChunkText in ingest/chunking.ts). Strip exactly that line when it
 * matches so the viewer does not render headings twice.
 */
export function stripHeadingPrefix(text: string, label: string): string {
  if (!label) return text;
  const prefix = `${label}\n`;
  if (text.startsWith(prefix)) {
    return text.slice(prefix.length).trimStart();
  }
  return text;
}

/** Case-insensitive substring match across chunk text and heading path. */
export function matchesChunkFilter(chunk: KbChunkRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    chunk.text.toLowerCase().includes(q) ||
    chunkHeadingLabel(chunk.meta).toLowerCase().includes(q)
  );
}
