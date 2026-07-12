/** Block + bullet + fact embedding pipeline: aiEmbed → career_store_embeddings. */

import { invoke } from "@tauri-apps/api/core";
import { aiEmbed } from "@/lib/ai-assist";
import { RECOMMENDED_EMBED_MODEL } from "@/lib/ollama";
import { computeEmbeddingText } from "./block-helpers";
import type {
  EmbedPipelineResult,
  EmbeddingItem,
  EmbeddingOwnerKind,
  ExperienceBlock,
  ProcessingProgress,
} from "./types";

/** Modest batch size so we don't starve the 3-slot AI concurrency gate. */
export const BLOCK_EMBED_BATCH_SIZE = 8;

export interface EmbedOwnerTextsOptions {
  items: { id: string; text: string }[];
  ownerKind: EmbeddingOwnerKind;
  model?: string;
  onProgress?: (done: number, total: number) => void;
  onProcessingProgress?: (progress: ProcessingProgress) => void;
  itemLabel?: string;
}

function backfillHintForKind(ownerKind: EmbeddingOwnerKind): string {
  switch (ownerKind) {
    case "bullet":
      return "backfillBulletEmbeddings()";
    case "fact":
      return "backfillFactEmbeddings()";
    default:
      return "backfillBlockEmbeddings()";
  }
}

function kindLabelFor(ownerKind: EmbeddingOwnerKind): string {
  switch (ownerKind) {
    case "bullet":
      return "Bullets";
    case "fact":
      return "Facts";
    case "chunk":
      return "Chunks";
    default:
      return "Blocks";
  }
}

/**
 * Embed owner texts and persist via `career_store_embeddings`.
 * On embed failure, returns `{ deferred: true }` so callers can keep the
 * save and backfill later.
 */
export async function embedOwnerTexts(
  options: EmbedOwnerTextsOptions,
): Promise<EmbedPipelineResult> {
  const { items, ownerKind, onProgress, onProcessingProgress, itemLabel } =
    options;
  if (items.length === 0) {
    return { embedded: 0, skipped: 0, deferred: false };
  }

  const model = options.model ?? RECOMMENDED_EMBED_MODEL.id;
  let embedded = 0;
  const batchTotal = Math.ceil(items.length / BLOCK_EMBED_BATCH_SIZE);

  try {
    for (let i = 0; i < items.length; i += BLOCK_EMBED_BATCH_SIZE) {
      const batchIndex = Math.floor(i / BLOCK_EMBED_BATCH_SIZE) + 1;
      onProcessingProgress?.({
        phase: "embed",
        current: batchIndex,
        total: batchTotal,
        itemLabel: itemLabel ?? `${ownerKind} embeddings`,
        chunks: embedded,
        detail: `Embedding ${ownerKind} batch ${batchIndex}/${batchTotal} (${embedded}/${items.length})`,
      });
      const batch = items.slice(i, i + BLOCK_EMBED_BATCH_SIZE);
      const vectors = await aiEmbed(batch.map((b) => b.text));
      if (vectors.length !== batch.length) {
        throw new Error(
          `aiEmbed returned ${vectors.length} vectors for ${batch.length} texts`,
        );
      }
      const embeddingItems: EmbeddingItem[] = batch.map((b, j) => ({
        ownerId: b.id,
        ownerKind,
        model,
        vec: vectors[j]!,
      }));
      await invoke<void>("career_store_embeddings", { items: embeddingItems });
      embedded += batch.length;
      onProgress?.(embedded, items.length);
      onProcessingProgress?.({
        phase: "embed",
        current: Math.min(embedded, items.length),
        total: items.length,
        itemLabel: itemLabel ?? `${ownerKind} embeddings`,
        chunks: embedded,
        detail: `Embedded ${embedded}/${items.length} ${ownerKind}(s)`,
      });
    }
    return { embedded, skipped: 0, deferred: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const noModel =
      /E_NO_MODEL|no embedding model|embed/i.test(message) ||
      /failed to embed/i.test(message);
    const kindLabel = kindLabelFor(ownerKind);
    const backfillHint = backfillHintForKind(ownerKind);
    onProcessingProgress?.({
      phase: "error",
      current: embedded,
      total: items.length,
      itemLabel: itemLabel ?? `${ownerKind} embeddings`,
      chunks: embedded,
      detail: message,
    });
    return {
      embedded,
      skipped: items.length - embedded,
      deferred: true,
      error: noModel
        ? `Embeddings unavailable (${RECOMMENDED_EMBED_MODEL.pull}). ${kindLabel} stored; call ${backfillHint} when a provider is ready.`
        : message,
    };
  }
}

export interface EmbedBlocksOptions {
  blocks: { id: string; text: string }[];
  model?: string;
  onProgress?: (done: number, total: number) => void;
  onProcessingProgress?: (progress: ProcessingProgress) => void;
  itemLabel?: string;
}

/**
 * Embed block texts and persist via `career_store_embeddings` with
 * `ownerKind: "block"`. On embed failure, returns `{ deferred: true }` so
 * callers can keep the block save and backfill later.
 */
export async function embedBlocks(
  options: EmbedBlocksOptions,
): Promise<EmbedPipelineResult> {
  return embedOwnerTexts({
    items: options.blocks,
    ownerKind: "block",
    model: options.model,
    onProgress: options.onProgress,
    onProcessingProgress: options.onProcessingProgress,
    itemLabel: options.itemLabel,
  });
}

export interface EmbedBulletsOptions {
  bullets: { id: string; text: string }[];
  model?: string;
  onProgress?: (done: number, total: number) => void;
  onProcessingProgress?: (progress: ProcessingProgress) => void;
  itemLabel?: string;
}

/**
 * Embed bullet canonical texts with `ownerKind: "bullet"`.
 */
export async function embedBullets(
  options: EmbedBulletsOptions,
): Promise<EmbedPipelineResult> {
  return embedOwnerTexts({
    items: options.bullets,
    ownerKind: "bullet",
    model: options.model,
    onProgress: options.onProgress,
    onProcessingProgress: options.onProcessingProgress,
    itemLabel: options.itemLabel,
  });
}

export interface EmbedFactsOptions {
  facts: { id: string; text: string }[];
  model?: string;
  onProgress?: (done: number, total: number) => void;
  onProcessingProgress?: (progress: ProcessingProgress) => void;
  itemLabel?: string;
}

/**
 * Embed fact texts with `ownerKind: "fact"`.
 */
export async function embedFacts(
  options: EmbedFactsOptions,
): Promise<EmbedPipelineResult> {
  return embedOwnerTexts({
    items: options.facts,
    ownerKind: "fact",
    model: options.model,
    onProgress: options.onProgress,
    onProcessingProgress: options.onProcessingProgress,
    itemLabel: options.itemLabel,
  });
}

function mergeEmbedResults(
  a: EmbedPipelineResult,
  b: EmbedPipelineResult,
): EmbedPipelineResult {
  return {
    embedded: a.embedded + b.embedded,
    skipped: a.skipped + b.skipped,
    deferred: a.deferred || b.deferred,
    error: a.error ?? b.error,
  };
}

function bulletEmbedItems(
  block: ExperienceBlock,
): { id: string; text: string }[] {
  return block.bullets
    .map((b) => ({ id: b.id, text: b.canonical.trim() }))
    .filter((b) => b.text.length > 0);
}

function factEmbedItems(
  block: ExperienceBlock,
): { id: string; text: string }[] {
  return (block.facts ?? [])
    .map((f) => ({ id: f.id, text: f.text.trim() }))
    .filter((f) => f.text.length > 0);
}

/** Persist block + bullet + fact embeddings after a successful upsert. Never throws. */
export async function persistBlockEmbedding(
  block: ExperienceBlock,
): Promise<EmbedPipelineResult> {
  const text =
    block.embeddingText?.trim() || computeEmbeddingText(block).trim();
  const blockResult = text
    ? await embedBlocks({ blocks: [{ id: block.id, text }] })
    : { embedded: 0, skipped: 1, deferred: false };

  const bullets = bulletEmbedItems(block);
  const bulletResult =
    bullets.length > 0
      ? await embedBullets({ bullets })
      : { embedded: 0, skipped: 0, deferred: false };

  const facts = factEmbedItems(block);
  const factResult =
    facts.length > 0
      ? await embedFacts({ facts })
      : { embedded: 0, skipped: 0, deferred: false };

  return mergeEmbedResults(
    mergeEmbedResults(blockResult, bulletResult),
    factResult,
  );
}

/**
 * Embed all experience blocks that lack vectors.
 * Safe to call after installing nomic-embed-text / enabling cloud embeddings.
 * Also backfills bullet and fact embeddings for all blocks (idempotent upsert).
 */
export async function backfillBlockEmbeddings(options?: {
  model?: string;
  onProgress?: (done: number, total: number) => void;
  onProcessingProgress?: (progress: ProcessingProgress) => void;
}): Promise<EmbedPipelineResult> {
  const rows = await invoke<ExperienceBlock[]>("career_list_blocks", {
    missingEmbeddingsOnly: true,
  });
  const blocks = rows
    .map((b) => ({
      id: b.id,
      text: (b.embeddingText?.trim() || computeEmbeddingText(b)).trim(),
    }))
    .filter((b) => b.text.length > 0);
  const emptySkipped = rows.length - blocks.length;
  const blockResult = await embedBlocks({
    blocks,
    model: options?.model,
    onProgress: options?.onProgress,
    onProcessingProgress: options?.onProcessingProgress,
    itemLabel: "Embed all blocks",
  });
  const withEmpty =
    emptySkipped > 0
      ? { ...blockResult, skipped: blockResult.skipped + emptySkipped }
      : blockResult;

  const bulletResult = await backfillBulletEmbeddings({
    model: options?.model,
    onProcessingProgress: options?.onProcessingProgress
      ? (p) =>
          options.onProcessingProgress?.({
            ...p,
            itemLabel: p.itemLabel ?? "Embed bullets",
          })
      : undefined,
  });
  const factResult = await backfillFactEmbeddings({
    model: options?.model,
    onProcessingProgress: options?.onProcessingProgress
      ? (p) =>
          options.onProcessingProgress?.({
            ...p,
            itemLabel: p.itemLabel ?? "Embed facts",
          })
      : undefined,
  });
  return mergeEmbedResults(
    mergeEmbedResults(withEmpty, bulletResult),
    factResult,
  );
}

/**
 * Embed every bullet canonical across all blocks (`ownerKind: "bullet"`).
 * Idempotent upsert — safe to re-run after provider install.
 */
export async function backfillBulletEmbeddings(options?: {
  model?: string;
  onProgress?: (done: number, total: number) => void;
  onProcessingProgress?: (progress: ProcessingProgress) => void;
}): Promise<EmbedPipelineResult> {
  const rows = await invoke<ExperienceBlock[]>("career_list_blocks", {
    missingEmbeddingsOnly: false,
  });
  const bullets = rows.flatMap(bulletEmbedItems);
  return embedBullets({
    bullets,
    model: options?.model,
    onProgress: options?.onProgress,
    onProcessingProgress: options?.onProcessingProgress,
    itemLabel: "Embed bullets",
  });
}

/**
 * Embed every fact text across all blocks (`ownerKind: "fact"`).
 * Idempotent upsert — safe to re-run after provider install.
 */
export async function backfillFactEmbeddings(options?: {
  model?: string;
  onProgress?: (done: number, total: number) => void;
  onProcessingProgress?: (progress: ProcessingProgress) => void;
}): Promise<EmbedPipelineResult> {
  const rows = await invoke<ExperienceBlock[]>("career_list_blocks", {
    missingEmbeddingsOnly: false,
  });
  const facts = rows.flatMap(factEmbedItems);
  return embedFacts({
    facts,
    model: options?.model,
    onProgress: options?.onProgress,
    onProcessingProgress: options?.onProcessingProgress,
    itemLabel: "Embed facts",
  });
}

/** Count of blocks with no embedding row (for UI badges). */
export async function countBlocksMissingEmbeddings(): Promise<number> {
  const rows = await invoke<ExperienceBlock[]>("career_list_blocks", {
    missingEmbeddingsOnly: true,
  });
  return rows.length;
}
