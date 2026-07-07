import {
  cacheKeyFor,
  semanticCache,
  type CacheLookupResult,
} from "@/lib/semantic-layer/cache";
import {
  formatCompressedContext,
  selectChunksMmr,
  type RagChunk,
} from "@/lib/semantic-layer/compressor";
import {
  resolveSemanticConfig,
  type SemanticLayerConfig,
} from "@/lib/semantic-layer/config";
import { routeQuery, type RouterDecision } from "@/lib/semantic-layer/router";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/runtime/is-tauri";

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface SemanticPipelineInput {
  prompt: string;
  system?: string;
  format?: "json";
  /** Optional RAG chunks to compress before inference. */
  contextChunks?: string[];
  defaultModel?: string | null;
  /** Skip cache lookup (still may route/compress). */
  skipCache?: boolean;
  /** Skip complexity routing (e.g. non-Ollama chat backends). */
  skipRouter?: boolean;
  /** Skip the entire semantic layer for this call. */
  skipSemanticLayer?: boolean;
}

export interface SemanticPipelineMeta {
  cacheHit: boolean;
  cacheScore?: number;
  tier?: RouterDecision["tier"];
  complexity?: number;
  modelUsed?: string | null;
  compressedChunkCount?: number;
  elapsedMs: number;
}

export interface SemanticPipelineResult {
  prompt: string;
  system?: string;
  model: string | null;
  meta: SemanticPipelineMeta;
}

export interface PreparedInference {
  prompt: string;
  system?: string;
  model: string | null;
  meta: SemanticPipelineMeta;
  /** When set, caller should return this without invoking the model. */
  cachedResponse?: string;
}

async function lookupSharedCache(
  queryVec: number[],
  key: string,
  config: SemanticLayerConfig,
): Promise<CacheLookupResult> {
  if (isTauri()) {
    try {
      const result = await invoke<CacheLookupResult>("semantic_cache_lookup", {
        embedding: queryVec,
        cacheKey: key,
      });
      if (result && typeof result.hit === "boolean") {
        return result;
      }
    } catch {
      // Fall back to the in-process cache when IPC is unavailable.
    }
  }
  return semanticCache.lookup(queryVec, key, config);
}

async function storeSharedCache(
  key: string,
  vec: number[],
  response: string,
  config: SemanticLayerConfig,
): Promise<void> {
  if (isTauri()) {
    try {
      await invoke("semantic_cache_store", {
        cacheKey: key,
        embedding: vec,
        response,
      });
      return;
    } catch {
      // Fall back to the in-process cache when IPC is unavailable.
    }
  }
  semanticCache.store(key, vec, response, config);
}

async function clearSharedCache(): Promise<void> {
  if (isTauri()) {
    try {
      await invoke("semantic_cache_clear");
    } catch {
      // Best-effort — still clear the local fallback below.
    }
  }
  semanticCache.clear();
}

function embedText(system: string | undefined, prompt: string): string {
  const sys = system?.trim();
  return sys ? `${sys}\n---\n${prompt}` : prompt;
}

async function compressContext(
  queryEmbedding: number[],
  chunks: string[],
  chunkEmbeddings: number[][],
  config: SemanticLayerConfig,
): Promise<string[]> {
  const ragChunks: RagChunk[] = chunks.map((text, i) => ({
    text,
    embedding: chunkEmbeddings[i],
  }));
  const indices = selectChunksMmr(
    queryEmbedding,
    ragChunks,
    config.maxRagChunks,
    config.mmrLambda,
  );
  return indices.map((i) => chunks[i]);
}

/**
 * Pre-inference semantic pass: cache lookup, RAG compression, model routing.
 * Fail-open — any embedding error returns the original inputs unchanged.
 */
export async function prepareSemanticInference(
  input: SemanticPipelineInput,
  embed: EmbedFn,
): Promise<PreparedInference> {
  const started = performance.now();
  const config = resolveSemanticConfig();

  const baseMeta: SemanticPipelineMeta = {
    cacheHit: false,
    elapsedMs: 0,
  };

  if (input.skipSemanticLayer || !config.enabled) {
    return {
      prompt: input.prompt,
      system: input.system,
      model: input.defaultModel ?? null,
      meta: { ...baseMeta, elapsedMs: performance.now() - started },
    };
  }

  let prompt = input.prompt;
  const system = input.system;
  let model = input.defaultModel ?? null;
  let compressedChunkCount: number | undefined;

  try {
    const embedTexts: string[] = [embedText(system, prompt)];
    const chunks = input.contextChunks?.filter((c) => c.trim()) ?? [];
    if (config.compressorEnabled && chunks.length > 0) {
      embedTexts.push(...chunks);
    }

    const vectors = await embed(embedTexts);
    if (vectors.length !== embedTexts.length) {
      throw new Error("Unexpected embedding batch size");
    }

    const [queryVec, ...chunkVecs] = vectors;

    if (config.compressorEnabled && chunks.length > 0 && chunkVecs.length > 0) {
      const selected = await compressContext(
        queryVec,
        chunks,
        chunkVecs,
        config,
      );
      compressedChunkCount = selected.length;
      const block = formatCompressedContext(selected);
      prompt = block ? `${block}\n\n${prompt}` : prompt;
    }

    if (config.cacheEnabled && !input.skipCache) {
      const key = cacheKeyFor(system, prompt);
      const lookup = await lookupSharedCache(queryVec, key, config);
      if (lookup.hit && lookup.response) {
        return {
          prompt,
          system,
          model,
          cachedResponse: lookup.response,
          meta: {
            cacheHit: true,
            cacheScore: lookup.score,
            compressedChunkCount,
            elapsedMs: performance.now() - started,
          },
        };
      }
    }

    if (config.routerEnabled && !input.skipRouter) {
      const decision = routeQuery(prompt, config, model, {
        system,
        format: input.format,
      });
      if (decision.modelOverride) {
        model = decision.modelOverride;
      }
      return {
        prompt,
        system,
        model,
        meta: {
          cacheHit: false,
          tier: decision.tier,
          complexity: decision.complexity,
          modelUsed: model,
          compressedChunkCount,
          elapsedMs: performance.now() - started,
        },
      };
    }
  } catch {
    // Fail-open to inference on any semantic-layer error.
  }

  return {
    prompt,
    system,
    model,
    meta: {
      ...baseMeta,
      compressedChunkCount,
      elapsedMs: performance.now() - started,
    },
  };
}

/** Store a successful inference result in the semantic cache. */
export async function storeSemanticCache(
  input: SemanticPipelineInput,
  response: string,
  embed: EmbedFn,
): Promise<void> {
  const config = resolveSemanticConfig();
  if (!config.enabled || !config.cacheEnabled || input.skipCache) return;

  try {
    const key = cacheKeyFor(input.system, input.prompt);
    const [vec] = await embed([embedText(input.system, input.prompt)]);
    if (vec) {
      await storeSharedCache(key, vec, response, config);
    }
  } catch {
    // Best-effort cache write.
  }
}

/** Clear the in-memory semantic cache (e.g. from settings). */
export function clearSemanticCache(): void {
  void clearSharedCache();
}
