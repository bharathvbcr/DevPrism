import { join } from "@tauri-apps/api/path";
import { readFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { StructuredTextData } from "@/lib/mupdf/types";

const PDF_CONTEXT_CHAR_LIMIT = 80_000;

export interface PdfTextSidecar {
  pageCount: number;
  sidecarRelativePath: string;
  sidecarAbsolutePath: string;
  sidecarContent: string;
  contextText: string;
}

export function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

function structuredTextToPlainText(data: StructuredTextData): string {
  const lines: string[] = [];

  for (const block of data.blocks || []) {
    if (block.type !== "text") continue;

    let addedBlockLine = false;
    for (const line of block.lines || []) {
      const text = line.text?.trimEnd();
      if (!text) continue;

      lines.push(text);
      addedBlockLine = true;
    }

    if (addedBlockLine) {
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

async function extractPdfText(absolutePath: string): Promise<{
  pageCount: number;
  pages: string[];
}> {
  const bytes = await readFile(absolutePath);
  const buffer = new Uint8Array(bytes).buffer;
  const client = getMupdfClient();
  const docId = await client.openDocument(buffer, "application/pdf");

  try {
    const pageCount = await client.countPages(docId);
    const pages: string[] = [];

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const structuredText = await client.getPageText(docId, pageIndex);
      pages.push(structuredTextToPlainText(structuredText));
    }

    return { pageCount, pages };
  } finally {
    await client.closeDocument(docId).catch(() => {});
  }
}

function buildSidecarContent(
  pdfRelativePath: string,
  pageCount: number,
  pages: string[],
): string {
  const body = pages
    .map((text, index) => {
      const pageText = text.trim() || "[No extractable text on this page]";
      return `## Page ${index + 1}\n\n${pageText}`;
    })
    .join("\n\n---\n\n");

  return [
    `# Extracted PDF Text: ${pdfRelativePath}`,
    "",
    `Pages: ${pageCount}`,
    "",
    body,
    "",
  ].join("\n");
}

function buildContextText(
  pdfRelativePath: string,
  sidecarRelativePath: string,
  pageCount: number,
  sidecarContent: string,
): string {
  const truncated =
    sidecarContent.length > PDF_CONTEXT_CHAR_LIMIT
      ? `${sidecarContent.slice(0, PDF_CONTEXT_CHAR_LIMIT)}\n\n[Truncated for chat context. Full extracted text is available at ${sidecarRelativePath}.]`
      : sidecarContent;

  return [
    `[PDF attachment: ${pdfRelativePath}]`,
    `[ClaudePrism extracted ${pageCount} page(s) with built-in MuPDF.]`,
    `[Use this extracted text first. If you need more, read ${sidecarRelativePath}; do not rely on the raw PDF reader unless Poppler is installed.]`,
    "",
    truncated,
  ].join("\n");
}

export async function createPdfTextSidecar(
  projectRoot: string,
  pdfRelativePath: string,
  pdfAbsolutePath: string,
): Promise<PdfTextSidecar> {
  const { pageCount, pages } = await extractPdfText(pdfAbsolutePath);
  const sidecarRelativePath = `${pdfRelativePath}.txt`;
  const sidecarAbsolutePath = await join(projectRoot, sidecarRelativePath);
  const sidecarContent = buildSidecarContent(pdfRelativePath, pageCount, pages);

  await writeTextFile(sidecarAbsolutePath, sidecarContent);

  return {
    pageCount,
    sidecarRelativePath,
    sidecarAbsolutePath,
    sidecarContent,
    contextText: buildContextText(
      pdfRelativePath,
      sidecarRelativePath,
      pageCount,
      sidecarContent,
    ),
  };
}
