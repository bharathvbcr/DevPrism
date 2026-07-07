import {
  prepareSemanticInference,
  storeSemanticCache,
  type EmbedFn,
  type PreparedInference,
  type SemanticPipelineInput,
  type SemanticPipelineMeta,
} from "@/lib/semantic-layer/pipeline";

export interface SemanticLayerRunResult<T> {
  result: T;
  meta: SemanticPipelineMeta;
  cacheHit: boolean;
}

/**
 * Shared semantic pass for all frontend inference paths: cache → compress → route
 * → infer → store. Fail-open — embedding errors fall through to `infer`.
 */
export async function runWithSemanticLayer<T extends string>(
  input: SemanticPipelineInput,
  infer: (prepared: PreparedInference) => Promise<T>,
  embed: EmbedFn,
  options?: { onCachedResult?: (text: T) => void },
): Promise<SemanticLayerRunResult<T>> {
  const prepared = await prepareSemanticInference(input, embed);

  if (prepared.cachedResponse != null) {
    options?.onCachedResult?.(prepared.cachedResponse as T);
    return {
      result: prepared.cachedResponse as T,
      meta: prepared.meta,
      cacheHit: true,
    };
  }

  const result = await infer(prepared);

  void storeSemanticCache(
    {
      prompt: prepared.prompt,
      system: prepared.system,
      skipCache: input.skipCache,
    },
    result,
    embed,
  );

  return {
    result,
    meta: prepared.meta,
    cacheHit: false,
  };
}

/** Prepare a conversational prompt/model for native agent or proxy paths. */
export async function prepareChatSemanticInference(
  input: SemanticPipelineInput,
  embed: EmbedFn,
): Promise<PreparedInference> {
  return prepareSemanticInference(input, embed);
}
