---
name: semantic-layer
description: "Skill for the Semantic-layer area of DevPrism. 33 symbols across 10 files."
---

# Semantic-layer

33 symbols | 10 files | Cohesion: 58%

## When to Use

- Working with code in `apps/`
- Understanding how isTauri, syncSemanticLayerConfig, maybeAutoEnableSemanticLayer work
- Modifying semantic-layer-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/semantic-layer/pipeline.ts` | clearSharedCache, clearSemanticCache, lookupSharedCache, storeSharedCache, compressContext (+3) |
| `apps/desktop/src/lib/semantic-layer/cache.ts` | clear, lookup, store, evictExpired, evictLru (+1) |
| `apps/desktop/src/lib/semantic-layer-bridge.ts` | syncSemanticLayerConfig, maybeAutoEnableSemanticLayer, watchSemanticLayerConfigSync, extractLastAssistantText, completeSemanticTurn |
| `apps/desktop/src/lib/semantic-layer/router.ts` | scoreComplexity, tierForComplexity, modelForTier, routeQuery |
| `apps/desktop/src/lib/semantic-layer/config.ts` | effectiveHitThreshold, resolveSemanticConfig |
| `apps/desktop/src/lib/ai-assist.ts` | semanticRank, semanticRankTemplates |
| `apps/desktop/src/lib/semantic-layer/compressor.ts` | selectChunksMmr, formatCompressedContext |
| `apps/desktop/src/lib/semantic-layer/run-with-semantic-layer.ts` | runWithSemanticLayer, prepareChatSemanticInference |
| `apps/desktop/src/lib/runtime/is-tauri.ts` | isTauri |
| `apps/desktop/src/lib/semantic-layer/math.ts` | cosineSimilarity |

## Entry Points

Start here when exploring this area:

- **`isTauri`** (Function) — `apps/desktop/src/lib/runtime/is-tauri.ts:1`
- **`syncSemanticLayerConfig`** (Function) — `apps/desktop/src/lib/semantic-layer-bridge.ts:18`
- **`maybeAutoEnableSemanticLayer`** (Function) — `apps/desktop/src/lib/semantic-layer-bridge.ts:49`
- **`watchSemanticLayerConfigSync`** (Function) — `apps/desktop/src/lib/semantic-layer-bridge.ts:74`
- **`clearSemanticCache`** (Function) — `apps/desktop/src/lib/semantic-layer/pipeline.ts:272`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `isTauri` | Function | `apps/desktop/src/lib/runtime/is-tauri.ts` | 1 |
| `syncSemanticLayerConfig` | Function | `apps/desktop/src/lib/semantic-layer-bridge.ts` | 18 |
| `maybeAutoEnableSemanticLayer` | Function | `apps/desktop/src/lib/semantic-layer-bridge.ts` | 49 |
| `watchSemanticLayerConfigSync` | Function | `apps/desktop/src/lib/semantic-layer-bridge.ts` | 74 |
| `clearSemanticCache` | Function | `apps/desktop/src/lib/semantic-layer/pipeline.ts` | 272 |
| `effectiveHitThreshold` | Function | `apps/desktop/src/lib/semantic-layer/config.ts` | 57 |
| `semanticRank` | Function | `apps/desktop/src/lib/ai-assist.ts` | 373 |
| `semanticRankTemplates` | Function | `apps/desktop/src/lib/ai-assist.ts` | 820 |
| `selectChunksMmr` | Function | `apps/desktop/src/lib/semantic-layer/compressor.ts` | 11 |
| `cosineSimilarity` | Function | `apps/desktop/src/lib/semantic-layer/math.ts` | 1 |
| `completeSemanticTurn` | Function | `apps/desktop/src/lib/semantic-layer-bridge.ts` | 152 |
| `resolveSemanticConfig` | Function | `apps/desktop/src/lib/semantic-layer/config.ts` | 42 |
| `storeSemanticCache` | Function | `apps/desktop/src/lib/semantic-layer/pipeline.ts` | 252 |
| `runWithSemanticLayer` | Function | `apps/desktop/src/lib/semantic-layer/run-with-semantic-layer.ts` | 19 |
| `cacheKeyFor` | Function | `apps/desktop/src/lib/semantic-layer/cache.ts` | 21 |
| `formatCompressedContext` | Function | `apps/desktop/src/lib/semantic-layer/compressor.ts` | 56 |
| `prepareSemanticInference` | Function | `apps/desktop/src/lib/semantic-layer/pipeline.ts` | 142 |
| `prepareChatSemanticInference` | Function | `apps/desktop/src/lib/semantic-layer/run-with-semantic-layer.ts` | 56 |
| `scoreComplexity` | Function | `apps/desktop/src/lib/semantic-layer/router.ts` | 20 |
| `tierForComplexity` | Function | `apps/desktop/src/lib/semantic-layer/router.ts` | 50 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `TemplateGallery → IsOllamaEndpoint` | cross_community | 6 |
| `HandleComplete → EvictExpired` | cross_community | 6 |
| `HandleComplete → EvictLru` | cross_community | 6 |
| `TemplateGallery → ThrowIfAborted` | cross_community | 5 |
| `TemplateGallery → IsCliProviderId` | cross_community | 5 |
| `TemplateGallery → AcquireAiSlot` | cross_community | 5 |
| `HandleComplete → IsTauri` | cross_community | 5 |
| `CareerKnowledgeTab → IsTauri` | cross_community | 4 |
| `TemplateGallery → CosineSimilarity` | cross_community | 4 |
| `HandleComplete → ResolveSemanticConfig` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Claude-chat | 3 calls |
| Workspace | 1 calls |

## How to Explore

1. `context({name: "isTauri"})` — see callers and callees
2. `query({search_query: "semantic-layer"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
