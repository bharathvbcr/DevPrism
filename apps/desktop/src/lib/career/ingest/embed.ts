/** Embedding pipeline: aiEmbed → career_store_embeddings, with graceful fallback. */

import { invoke } from "@tauri-apps/api/core";
import { aiEmbed } from "@/lib/ai-assist";
import { RECOMMENDED_EMBED_MODEL } from "@/lib/ollama";
import type {
  EmbedPipelineResult,
  EmbeddingItem,
  KbChunkRow,
  ProcessingProgress,
} from "../types";

/** Modest batch size so we don't starve the 3-slot AI concurrency gate. */
export const EMBED_BATCH_SIZE = 8;

export interface EmbedChunksOptions {
  /** Chunk rows (id + text) to embed. */
  chunks: { id: string; text: string }[];
  /** Embedding model label stored alongside vectors. */
  model?: string;
  /** Legacy (done, total) callback — still supported. */
  onProgress?: (done: number, total: number) => void;
  /** Rich progress for UI (preferred). */
  onProcessingProgress?: (progress: ProcessingProgress) => void;
  /** Optional label for the current source / batch group. */
  itemLabel?: string;
}

/**
 * Embed chunk texts and persist via `career_store_embeddings`.
 * On `[E_NO_MODEL]` / embed failure, returns `{ deferred: true }` so callers
 * can keep chunks without vectors and backfill later.
 */
export async function embedChunks(
  options: EmbedChunksOptions,
): Promise<EmbedPipelineResult> {
  const { chunks, onProgress, onProcessingProgress, itemLabel } = options;
  if (chunks.length === 0) {
    return { embedded: 0, skipped: 0, deferred: false };
  }

  const model = options.model ?? RECOMMENDED_EMBED_MODEL.id;
  let embedded = 0;
  const batchTotal = Math.ceil(chunks.length / EMBED_BATCH_SIZE);

  try {
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batchIndex = Math.floor(i / EMBED_BATCH_SIZE) + 1;
      onProcessingProgress?.({
        phase: "embed",
        current: batchIndex,
        total: batchTotal,
        itemLabel,
        chunks: embedded,
        detail: `Embedding batch ${batchIndex}/${batchTotal} (${embedded}/${chunks.length} chunks)`,
      });

      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await aiEmbed(batch.map((c) => c.text));
      if (vectors.length !== batch.length) {
        throw new Error(
          `aiEmbed returned ${vectors.length} vectors for ${batch.length} texts`,
        );
      }
      const items: EmbeddingItem[] = batch.map((c, j) => ({
        ownerId: c.id,
        ownerKind: "chunk",
        model,
        vec: vectors[j]!,
      }));
      await invoke<void>("career_store_embeddings", { items });
      embedded += batch.length;
      onProgress?.(embedded, chunks.length);
      onProcessingProgress?.({
        phase: "embed",
        current: batchIndex,
        total: batchTotal,
        itemLabel,
        chunks: embedded,
        detail: `Embedded ${embedded}/${chunks.length} chunks`,
      });
    }
    return { embedded, skipped: 0, deferred: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const noModel =
      /E_NO_MODEL|no embedding model|embed/i.test(message) ||
      /failed to embed/i.test(message);
    onProcessingProgress?.({
      phase: "error",
      current: embedded,
      total: chunks.length,
      itemLabel,
      chunks: embedded,
      detail: message,
    });
    return {
      embedded,
      skipped: chunks.length - embedded,
      deferred: true,
      error: noModel
        ? `Embeddings unavailable (${RECOMMENDED_EMBED_MODEL.pull}). Chunks stored; call backfillKbEmbeddings() when a provider is ready.`
        : message,
    };
  }
}

/**
 * Embed all KB chunks that lack vectors (or only those for `sourceId`).
 * Safe to call after installing nomic-embed-text / enabling cloud embeddings.
 */
export async function backfillKbEmbeddings(options?: {
  sourceId?: string;
  model?: string;
  onProgress?: (done: number, total: number) => void;
  onProcessingProgress?: (progress: ProcessingProgress) => void;
}): Promise<EmbedPipelineResult> {
  const rows = await invoke<KbChunkRow[]>("career_list_kb_chunks", {
    sourceId: options?.sourceId ?? null,
    missingEmbeddingsOnly: true,
  });
  return embedChunks({
    chunks: rows.map((r) => ({ id: r.id, text: r.text })),
    model: options?.model,
    onProgress: options?.onProgress,
    onProcessingProgress: options?.onProcessingProgress,
    itemLabel: options?.sourceId ? "Backfill source" : "Backfill all chunks",
  });
}

/** True when the error / result indicates embeddings were deferred. */
export function isEmbedDeferred(result: EmbedPipelineResult): boolean {
  return result.deferred;
}
