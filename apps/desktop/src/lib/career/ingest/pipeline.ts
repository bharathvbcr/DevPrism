/** High-level KB ingestion: chunk → upsert → embed. */

import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { readTexFileContent } from "@/lib/tauri/fs";
import { sha1HexSync } from "./hash";
import { chunkMarkdown } from "./markdown";
import { chunkMindmap } from "./mindmap";
import { chunkPdf } from "./pdf";
import { embedChunks, type EmbedChunksOptions } from "./embed";
import type {
  EmbedPipelineResult,
  IngestReport,
  KbChunkRow,
  KbSourceType,
  PreparedChunk,
  PreparedSource,
  ProcessingProgress,
} from "../types";

export type { ProcessingProgress, ProcessingPhase } from "../types";

export interface IngestAndEmbedResult {
  report: IngestReport;
  embed: EmbedPipelineResult;
}

export interface IngestTextOptions {
  uri: string;
  title: string;
  sourceType: KbSourceType | string;
  date?: string;
  /** Skip embedding (store chunks only). */
  skipEmbed?: boolean;
  onEmbedProgress?: EmbedChunksOptions["onProgress"];
  onProgress?: (progress: ProcessingProgress) => void;
}

function emitProgress(
  onProgress: ((p: ProcessingProgress) => void) | undefined,
  progress: ProcessingProgress,
) {
  onProgress?.(progress);
}

/** Build a PreparedSource from pre-chunked content. */
export function buildPreparedSource(
  chunks: PreparedChunk[],
  options: {
    uri: string;
    title: string;
    sourceType: KbSourceType | string;
    /** Full-document hash; defaults to hash of concatenated chunk texts. */
    contentHash?: string;
  },
): PreparedSource {
  const contentHash =
    options.contentHash ??
    sha1HexSync(chunks.map((c) => c.meta.contentHash).join("|"));
  return {
    uri: options.uri,
    sourceType: options.sourceType,
    title: options.title,
    contentHash,
    chunks: chunks.map((c, i) => ({
      text: c.text,
      meta: { ...c.meta, index: c.meta.index ?? i },
    })),
  };
}

/** Upsert prepared chunks and embed those in `needsEmbedding`. */
export async function upsertAndEmbed(
  prepared: PreparedSource,
  options?: {
    skipEmbed?: boolean;
    onEmbedProgress?: EmbedChunksOptions["onProgress"];
    onProgress?: (progress: ProcessingProgress) => void;
  },
): Promise<IngestAndEmbedResult> {
  const onProgress = options?.onProgress;
  emitProgress(onProgress, {
    phase: "upsert",
    current: 1,
    total: 1,
    itemLabel: prepared.title,
    chunks: prepared.chunks.length,
    detail: `Upserting ${prepared.chunks.length} chunk(s)…`,
  });

  const report = await invoke<IngestReport>("career_upsert_kb_source", {
    prepared,
  });
  if (options?.skipEmbed) {
    emitProgress(onProgress, {
      phase: "done",
      current: 1,
      total: 1,
      itemLabel: prepared.title,
      chunks: report.chunkCount,
      detail: "Stored without embedding",
    });
    return {
      report,
      embed: { embedded: 0, skipped: report.chunkCount, deferred: false },
    };
  }

  const needIds = new Set(report.needsEmbedding ?? report.chunkIds);
  if (needIds.size === 0) {
    emitProgress(onProgress, {
      phase: "done",
      current: 1,
      total: 1,
      itemLabel: prepared.title,
      chunks: report.chunkCount,
      detail: "Already up to date",
    });
    return {
      report,
      embed: { embedded: 0, skipped: 0, deferred: false },
    };
  }

  const rows = await invoke<KbChunkRow[]>("career_list_kb_chunks", {
    sourceId: report.sourceId,
    missingEmbeddingsOnly: false,
  });
  const toEmbed = rows
    .filter((r) => needIds.has(r.id))
    .map((r) => ({ id: r.id, text: r.text }));

  const embed = await embedChunks({
    chunks: toEmbed,
    onProgress: options?.onEmbedProgress,
    onProcessingProgress: onProgress,
    itemLabel: prepared.title,
  });

  emitProgress(onProgress, {
    phase: embed.deferred ? "error" : "done",
    current: 1,
    total: 1,
    itemLabel: prepared.title,
    chunks: embed.embedded,
    detail: embed.deferred
      ? (embed.error ?? "Embeddings deferred")
      : `Done — ${embed.embedded} embedded`,
  });

  return { report, embed };
}

/** Ingest a markdown / Obsidian string. */
export async function ingestMarkdownText(
  markdown: string,
  options: IngestTextOptions & { obsidian?: boolean },
): Promise<IngestAndEmbedResult> {
  const onProgress = options.onProgress;
  emitProgress(onProgress, {
    phase: "parse",
    current: 1,
    total: 1,
    itemLabel: options.title,
    bytes: markdown.length,
    detail: "Parsing markdown…",
  });
  emitProgress(onProgress, {
    phase: "chunk",
    current: 1,
    total: 1,
    itemLabel: options.title,
    detail: "Chunking by headings…",
  });
  const chunks = chunkMarkdown(markdown, {
    sourceTitle: options.title,
    date: options.date,
    obsidian: options.obsidian,
  });
  emitProgress(onProgress, {
    phase: "hash",
    current: 1,
    total: 1,
    itemLabel: options.title,
    chunks: chunks.length,
    detail: `Hashed ${chunks.length} chunk(s)`,
  });
  const prepared = buildPreparedSource(chunks, {
    uri: options.uri,
    title: options.title,
    sourceType: options.sourceType || "markdown",
    contentHash: sha1HexSync(markdown),
  });
  return upsertAndEmbed(prepared, options);
}

/** Ingest OPML or FreeMind XML. */
export async function ingestMindmapText(
  xml: string,
  options: IngestTextOptions,
): Promise<IngestAndEmbedResult> {
  const onProgress = options.onProgress;
  emitProgress(onProgress, {
    phase: "parse",
    current: 1,
    total: 1,
    itemLabel: options.title,
    bytes: xml.length,
    detail: "Parsing mind map…",
  });
  const chunks = chunkMindmap(xml, {
    sourceTitle: options.title,
    date: options.date,
  });
  emitProgress(onProgress, {
    phase: "chunk",
    current: 1,
    total: 1,
    itemLabel: options.title,
    chunks: chunks.length,
    detail: `Chunked ${chunks.length} outline section(s)`,
  });
  const prepared = buildPreparedSource(chunks, {
    uri: options.uri,
    title: options.title,
    sourceType: options.sourceType || "mindmap",
    contentHash: sha1HexSync(xml),
  });
  return upsertAndEmbed(prepared, options);
}

/** Ingest a PDF ArrayBuffer via MuPDF. */
export async function ingestPdfBuffer(
  buffer: ArrayBuffer,
  options: IngestTextOptions,
): Promise<IngestAndEmbedResult> {
  const onProgress = options.onProgress;
  emitProgress(onProgress, {
    phase: "parse",
    current: 1,
    total: 1,
    itemLabel: options.title,
    bytes: buffer.byteLength,
    detail: "Extracting PDF text…",
  });
  const chunks = await chunkPdf(buffer, {
    sourceTitle: options.title,
    date: options.date,
  });
  if (chunks.length === 0) {
    emitProgress(onProgress, {
      phase: "error",
      current: 1,
      total: 1,
      itemLabel: options.title,
      bytes: buffer.byteLength,
      detail: "No extractable text found in PDF",
    });
    throw new Error("No extractable text found in PDF");
  }
  emitProgress(onProgress, {
    phase: "chunk",
    current: 1,
    total: 1,
    itemLabel: options.title,
    bytes: buffer.byteLength,
    chunks: chunks.length,
    detail: `Chunked ${chunks.length} section(s)`,
  });
  const bytes = new Uint8Array(buffer);
  const prepared = buildPreparedSource(chunks, {
    uri: options.uri,
    title: options.title,
    sourceType: options.sourceType || "pdf",
    contentHash: sha1HexSync(
      `${bytes.length}:${bytes[0]}:${bytes[bytes.length - 1]}:${chunks.map((c) => c.meta.contentHash).join("|")}`,
    ),
  });
  return upsertAndEmbed(prepared, options);
}

/**
 * Ingest a filesystem path. Dispatches by extension / sourceType:
 * - `.md` / markdown / wiki → text chunker
 * - `.opml` / `.mm` / mindmap → mindmap chunker
 * - `.pdf` / pdf → MuPDF
 * - otherwise → markdown-ish text
 */
export async function ingestFilePath(
  path: string,
  sourceType?: KbSourceType | string,
  options?: {
    title?: string;
    skipEmbed?: boolean;
    onEmbedProgress?: EmbedChunksOptions["onProgress"];
    onProgress?: (progress: ProcessingProgress) => void;
  },
): Promise<IngestAndEmbedResult> {
  const title =
    options?.title ??
    path
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") ??
    "untitled";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const kind =
    sourceType ??
    (ext === "pdf"
      ? "pdf"
      : ext === "opml" || ext === "mm"
        ? "mindmap"
        : ext === "md" || ext === "markdown"
          ? "markdown"
          : "wiki");

  const shared = {
    skipEmbed: options?.skipEmbed,
    onEmbedProgress: options?.onEmbedProgress,
    onProgress: options?.onProgress,
  };

  if (kind === "pdf" || ext === "pdf") {
    const bytes = await readFile(path);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return ingestPdfBuffer(buffer, {
      uri: path,
      title,
      sourceType: "pdf",
      ...shared,
    });
  }

  const text = await readTexFileContent(path);
  if (kind === "mindmap" || ext === "opml" || ext === "mm") {
    return ingestMindmapText(text, {
      uri: path,
      title,
      sourceType: "mindmap",
      ...shared,
    });
  }

  return ingestMarkdownText(text, {
    uri: path,
    title,
    sourceType: kind === "wiki" ? "wiki" : "markdown",
    obsidian: true,
    ...shared,
  });
}
