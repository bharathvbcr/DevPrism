/** Heading-aware text chunking: ~200–400 tokens, 15% overlap. */

import { sha1HexSync } from "./hash";
import type { KbChunkMeta, PreparedChunk } from "../types";

/** ~4 chars/token heuristic used across the KB pipeline. */
export const CHARS_PER_TOKEN = 4;
export const TARGET_MIN_TOKENS = 200;
export const TARGET_MAX_TOKENS = 400;
export const OVERLAP_RATIO = 0.15;

export const TARGET_MIN_CHARS = TARGET_MIN_TOKENS * CHARS_PER_TOKEN; // 800
export const TARGET_MAX_CHARS = TARGET_MAX_TOKENS * CHARS_PER_TOKEN; // 1600
export const TARGET_CHARS = Math.round(
  (TARGET_MIN_CHARS + TARGET_MAX_CHARS) / 2,
); // 1200

export interface TextSection {
  /** Heading breadcrumb, e.g. ["Projects", "DevPrism"]. */
  headingPath: string[];
  text: string;
}

export interface ChunkOptions {
  sourceTitle: string;
  date?: string;
  /** Extra meta fields merged into each chunk (e.g. page). */
  extraMeta?: Record<string, unknown>;
}

function overlapChars(chunkLen: number): number {
  return Math.max(40, Math.round(chunkLen * OVERLAP_RATIO));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Pack sections into overlapping windows of ~200–400 tokens.
 * Never merges across different heading paths.
 */
export function chunkSections(
  sections: TextSection[],
  options: ChunkOptions,
): PreparedChunk[] {
  const out: PreparedChunk[] = [];
  for (const section of sections) {
    const body = section.text.trim();
    if (!body) continue;
    const pieces = splitToWindows(body);
    for (const piece of pieces) {
      const text = formatChunkText(section.headingPath, piece);
      out.push(makeChunk(text, section.headingPath, options, out.length));
    }
  }
  return out;
}

/** Chunk a flat string (no headings) with the same window policy. */
export function chunkPlainText(
  text: string,
  options: ChunkOptions,
  headingPath: string[] = [],
): PreparedChunk[] {
  return chunkSections([{ headingPath, text }], options);
}

function formatChunkText(headingPath: string[], body: string): string {
  if (headingPath.length === 0) return body;
  return `${headingPath.join(" > ")}\n\n${body}`;
}

function makeChunk(
  text: string,
  headingPath: string[],
  options: ChunkOptions,
  index: number,
): PreparedChunk {
  const meta: KbChunkMeta = {
    sourceTitle: options.sourceTitle,
    headingPath: [...headingPath],
    contentHash: sha1HexSync(text),
    index,
    ...(options.date ? { date: options.date } : {}),
    ...options.extraMeta,
  };
  return { text, meta };
}

/**
 * Split body text into windows targeting TARGET_CHARS, preferring paragraph
 * then sentence boundaries. Adjacent windows share ~15% overlap.
 */
export function splitToWindows(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= TARGET_MAX_CHARS) return [trimmed];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const windows: string[] = [];
  let buf = "";

  const flush = (force = false) => {
    if (!buf.trim()) return;
    if (
      !force &&
      estimateTokens(buf) < TARGET_MIN_TOKENS &&
      windows.length === 0
    ) {
      return; // keep accumulating toward min on first window
    }
    windows.push(buf.trim());
    const ov = overlapChars(buf.length);
    const overlap = buf.length > ov ? buf.slice(buf.length - ov) : buf;
    buf = overlap.trimStart();
  };

  for (const para of paragraphs) {
    if (!buf) {
      buf = para;
    } else if (buf.length + 2 + para.length <= TARGET_MAX_CHARS) {
      buf = `${buf}\n\n${para}`;
    } else {
      if (
        estimateTokens(buf) >= TARGET_MIN_TOKENS ||
        para.length > TARGET_MAX_CHARS
      ) {
        flush(true);
        if (buf) buf = `${buf}\n\n${para}`;
        else buf = para;
      } else {
        // Below min — hard-append then flush if oversized
        buf = `${buf}\n\n${para}`;
        if (buf.length > TARGET_MAX_CHARS) flush(true);
      }
    }

    // Hard-split a single oversized paragraph.
    while (buf.length > TARGET_MAX_CHARS * 1.5) {
      const cut = findCut(buf, TARGET_CHARS);
      windows.push(buf.slice(0, cut).trim());
      const ov = overlapChars(cut);
      buf = buf.slice(Math.max(0, cut - ov)).trimStart();
    }
  }

  if (buf.trim()) {
    // Merge tiny tail into previous window when possible.
    if (
      windows.length > 0 &&
      estimateTokens(buf) < TARGET_MIN_TOKENS / 2 &&
      windows[windows.length - 1]!.length + buf.length < TARGET_MAX_CHARS
    ) {
      windows[windows.length - 1] =
        `${windows[windows.length - 1]}\n\n${buf.trim()}`;
    } else {
      windows.push(buf.trim());
    }
  }

  return windows.length > 0 ? windows : [trimmed];
}

/** Prefer sentence / newline boundary near `target`. */
function findCut(text: string, target: number): number {
  const limit = Math.min(text.length, Math.max(target, TARGET_MIN_CHARS));
  const window = text.slice(0, limit);
  const sentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf(".\n"),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (sentence >= TARGET_MIN_CHARS * 0.5) return sentence + 1;
  const nl = window.lastIndexOf("\n");
  if (nl >= TARGET_MIN_CHARS * 0.5) return nl;
  const space = window.lastIndexOf(" ");
  if (space >= TARGET_MIN_CHARS * 0.5) return space;
  return limit;
}

export { estimateTokens };
