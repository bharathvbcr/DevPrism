/** Seed publication KB chunks / ExperienceBlocks from Zotero / BibTeX exports. */

import { parseBibFile, type BibEntry } from "@/lib/bibtex";
import {
  computeEmbeddingText,
  createEmptyBlock,
  newBullet,
} from "../block-helpers";
import type {
  EmbedPipelineResult,
  ExperienceBlock,
  IngestReport,
  PreparedChunk,
} from "../types";
import { sha1HexSync } from "./hash";
import { buildPreparedSource, upsertAndEmbed } from "./pipeline";

export interface BibSeedOptions {
  /** Stable URI for the BibTeX source (e.g. zotero collection path). */
  uri: string;
  title?: string;
  skipEmbed?: boolean;
  onProgress?: (progress: import("../types").ProcessingProgress) => void;
}

export interface BibSeedResult {
  report: IngestReport;
  embed: EmbedPipelineResult;
  entryCount: number;
}

/** Venue string: journal, booktitle, or publisher (parser may set extras). */
export function bibEntryVenue(entry: BibEntry): string {
  const extra = entry as BibEntry & {
    booktitle?: string;
    publisher?: string;
  };
  return (extra.journal ?? extra.booktitle ?? extra.publisher ?? "").trim();
}

/**
 * Convert BibTeX entries into one KB chunk per entry (title/authors/venue/
 * year/abstract-ish fields). Suitable for seeding from Zotero sync output.
 */
export function bibEntriesToChunks(
  entries: BibEntry[],
  sourceTitle: string,
): PreparedChunk[] {
  return entries.map((entry, index) => {
    const venue = bibEntryVenue(entry);
    const lines = [
      entry.title ?? entry.key,
      entry.author ? `Authors: ${entry.author}` : null,
      entry.year ? `Year: ${entry.year}` : null,
      venue ? `Venue: ${venue}` : null,
      `Type: ${entry.type}`,
      `Citekey: ${entry.key}`,
    ].filter(Boolean) as string[];
    // Include a trimmed raw snippet for extra recall (no huge blobs).
    const rawSnippet = entry.raw.replace(/\s+/g, " ").trim().slice(0, 800);
    if (rawSnippet) lines.push(rawSnippet);
    const text = lines.join("\n");
    return {
      text,
      meta: {
        sourceTitle,
        headingPath: [entry.title ?? entry.key],
        contentHash: sha1HexSync(text),
        index,
        date: entry.year,
        citekey: entry.key,
        bibType: entry.type,
      },
    };
  });
}

/** Map one BibTeX entry to a draft `kind: "publication"` ExperienceBlock. */
export function bibEntryToPublicationBlock(entry: BibEntry): ExperienceBlock {
  const venue = bibEntryVenue(entry);
  const year = (entry.year ?? "").trim();
  const title = (entry.title ?? entry.key).trim() || entry.key;
  const citation = [
    entry.author?.trim(),
    year ? `(${year})` : null,
    title,
    venue || null,
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\. \(/, " (");
  const bullets = [
    newBullet(citation),
    newBullet(`Type: ${entry.type} · Citekey: ${entry.key}`),
  ];
  const block = createEmptyBlock({
    kind: "publication",
    title,
    org: venue,
    dateRange: { start: year, end: year || null },
    domains: entry.type ? [entry.type] : [],
    seniorityLevel: "ic",
    bullets,
  });
  return {
    ...block,
    embeddingText: computeEmbeddingText(block),
  };
}

/**
 * Convert BibTeX entries into draft publication ExperienceBlocks (not persisted).
 * Empty input returns []; callers that require entries should check length.
 */
export function bibEntriesToPublicationBlocks(
  entries: BibEntry[],
): ExperienceBlock[] {
  return entries.map(bibEntryToPublicationBlock);
}

/** Parse BibTeX text into draft publication blocks for preview / commit. */
export function parseBibtexToPublicationBlocks(
  bibtex: string,
): ExperienceBlock[] {
  const entries = parseBibFile(bibtex);
  if (entries.length === 0) {
    throw new Error("No BibTeX entries found to import");
  }
  return bibEntriesToPublicationBlocks(entries);
}

/** Parse BibTeX text and upsert publication chunks into the career KB. */
export async function seedPublicationsFromBibtex(
  bibtex: string,
  options: BibSeedOptions,
): Promise<BibSeedResult> {
  const entries = parseBibFile(bibtex);
  const title = options.title ?? "Publications";
  const chunks = bibEntriesToChunks(entries, title);
  if (chunks.length === 0) {
    throw new Error("No BibTeX entries found to seed");
  }
  const prepared = buildPreparedSource(chunks, {
    uri: options.uri,
    title,
    sourceType: "publication",
    contentHash: sha1HexSync(bibtex),
  });
  const { report, embed } = await upsertAndEmbed(prepared, {
    skipEmbed: options.skipEmbed,
    onProgress: options.onProgress,
  });
  return { report, embed, entryCount: entries.length };
}
