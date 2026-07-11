/** PDF text extraction via MuPDF, then heading-aware / page-scoped chunking. */

import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { StructuredTextData } from "@/lib/mupdf/types";
import { chunkPlainText, chunkSections, type TextSection } from "./chunking";
import { chunkMarkdown } from "./markdown";
import type { PreparedChunk } from "../types";

export interface PdfChunkOptions {
  sourceTitle: string;
  date?: string;
  /** Prefer markdown-style heading detection on extracted text (default true). */
  detectHeadings?: boolean;
}

/** Flatten MuPDF structured text into a plain paragraph string. */
export function flattenPageText(data: StructuredTextData): string {
  const lines: string[] = [];
  for (const block of data.blocks) {
    for (const line of block.lines) {
      const t = line.text?.trim();
      if (t) lines.push(t);
    }
  }
  return lines.join("\n");
}

/**
 * Extract all page text from a PDF ArrayBuffer via MuPDF.
 * Returns one string per page (empty pages omitted from the array but page
 * indices are preserved via `pageIndex`).
 */
export async function extractPdfPages(
  buffer: ArrayBuffer,
): Promise<{ pageIndex: number; text: string }[]> {
  const client = getMupdfClient();
  const docId = await client.openDocument(buffer, "application/pdf");
  try {
    const pageCount = await client.countPages(docId);
    const pages: { pageIndex: number; text: string }[] = [];
    for (let i = 0; i < pageCount; i++) {
      const structured = await client.getPageText(docId, i);
      const text = flattenPageText(structured).trim();
      if (text) pages.push({ pageIndex: i, text });
    }
    return pages;
  } finally {
    await client.closeDocument(docId).catch(() => undefined);
  }
}

/**
 * Chunk a PDF: extract per-page text, then either run markdown heading
 * detection across the joined document or chunk page-by-page.
 */
export async function chunkPdf(
  buffer: ArrayBuffer,
  options: PdfChunkOptions,
): Promise<PreparedChunk[]> {
  const pages = await extractPdfPages(buffer);
  if (pages.length === 0) return [];

  const detectHeadings = options.detectHeadings !== false;
  if (detectHeadings) {
    // Join with page markers so heading detection still works; attach page
    // meta from the first page that contributed to each chunk via extra pass.
    const joined = pages
      .map((p) => `## Page ${p.pageIndex + 1}\n\n${p.text}`)
      .join("\n\n");
    return chunkMarkdown(joined, {
      sourceTitle: options.sourceTitle,
      date: options.date,
      obsidian: false,
    });
  }

  const sections: TextSection[] = pages.map((p) => ({
    headingPath: [`Page ${p.pageIndex + 1}`],
    text: p.text,
  }));
  return chunkSections(sections, {
    sourceTitle: options.sourceTitle,
    date: options.date,
  });
}

/** Chunk already-extracted page texts (for tests / callers with text). */
export function chunkPdfPageTexts(
  pages: { pageIndex: number; text: string }[],
  options: PdfChunkOptions,
): PreparedChunk[] {
  if (pages.length === 0) return [];
  const chunks: PreparedChunk[] = [];
  for (const page of pages) {
    const pageChunks = chunkPlainText(
      page.text,
      {
        sourceTitle: options.sourceTitle,
        date: options.date,
        extraMeta: { page: page.pageIndex },
      },
      [`Page ${page.pageIndex + 1}`],
    );
    chunks.push(...pageChunks);
  }
  // Re-index
  return chunks.map((c, i) => ({
    ...c,
    meta: { ...c.meta, index: i },
  }));
}
