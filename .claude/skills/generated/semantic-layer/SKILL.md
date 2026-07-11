---
name: semantic-layer
description: "Skill for the Semantic-layer area of DevPrism. 35 symbols across 10 files."
---

# Semantic-layer

35 symbols | 10 files | Cohesion: 66%

## When to Use

- Working with code in `apps/`
- Understanding how aiCompleteStream, explainCompileErrorsStream, completeSemanticTurn work
- Modifying semantic-layer-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/semantic-layer/pipeline.ts` | embedText, prepareSemanticInference, storeSemanticCache, clearSharedCache, clearSemanticCache (+3) |
| `apps/desktop/src/lib/semantic-layer/cache.ts` | cacheKeyFor, clear, lookup, store, evictExpired (+1) |
| `apps/desktop/src/lib/semantic-layer-bridge.ts` | extractLastAssistantText, completeSemanticTurn, syncSemanticLayerConfig, maybeAutoEnableSemanticLayer, watchSemanticLayerConfigSync |
| `apps/desktop/src/lib/ai-assist.ts` | aiCompleteStream, explainCompileErrorsStream, semanticRank, semanticRankTemplates |
| `apps/desktop/src/lib/semantic-layer/router.ts` | scoreComplexity, tierForComplexity, modelForTier, routeQuery |
| `apps/desktop/src/lib/semantic-layer/compressor.ts` | formatCompressedContext, selectChunksMmr |
| `apps/desktop/src/lib/semantic-layer/config.ts` | resolveSemanticConfig, effectiveHitThreshold |
| `apps/desktop/src/lib/semantic-layer/run-with-semantic-layer.ts` | runWithSemanticLayer, prepareChatSemanticInference |
| `apps/desktop/src/lib/runtime/is-tauri.ts` | isTauri |
| `apps/desktop/src/lib/semantic-layer/math.ts` | cosineSimilarity |

## Entry Points

Start here when exploring this area:

- **`aiCompleteStream`** (Function) — `apps/desktop/src/lib/ai-assist.ts:153`
- **`explainCompileErrorsStream`** (Function) — `apps/desktop/src/lib/ai-assist.ts:418`
- **`completeSemanticTurn`** (Function) — `apps/desktop/src/lib/semantic-layer-bridge.ts:152`
- **`cacheKeyFor`** (Function) — `apps/desktop/src/lib/semantic-layer/cache.ts:21`
- **`formatCompressedContext`** (Function) — `apps/desktop/src/lib/semantic-layer/compressor.ts:56`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `aiCompleteStream` | Function | `apps/desktop/src/lib/ai-assist.ts` | 153 |
| `explainCompileErrorsStream` | Function | `apps/desktop/src/lib/ai-assist.ts` | 418 |
| `completeSemanticTurn` | Function | `apps/desktop/src/lib/semantic-layer-bridge.ts` | 152 |
| `cacheKeyFor` | Function | `apps/desktop/src/lib/semantic-layer/cache.ts` | 21 |
| `formatCompressedContext` | Function | `apps/desktop/src/lib/semantic-layer/compressor.ts` | 56 |
| `resolveSemanticConfig` | Function | `apps/desktop/src/lib/semantic-layer/config.ts` | 42 |
| `prepareSemanticInference` | Function | `apps/desktop/src/lib/semantic-layer/pipeline.ts` | 142 |
| `storeSemanticCache` | Function | `apps/desktop/src/lib/semantic-layer/pipeline.ts` | 252 |
| `runWithSemanticLayer` | Function | `apps/desktop/src/lib/semantic-layer/run-with-semantic-layer.ts` | 19 |
| `prepareChatSemanticInference` | Function | `apps/desktop/src/lib/semantic-layer/run-with-semantic-layer.ts` | 56 |
| `isTauri` | Function | `apps/desktop/src/lib/runtime/is-tauri.ts` | 1 |
| `syncSemanticLayerConfig` | Function | `apps/desktop/src/lib/semantic-layer-bridge.ts` | 18 |
| `maybeAutoEnableSemanticLayer` | Function | `apps/desktop/src/lib/semantic-layer-bridge.ts` | 49 |
| `watchSemanticLayerConfigSync` | Function | `apps/desktop/src/lib/semantic-layer-bridge.ts` | 74 |
| `clearSemanticCache` | Function | `apps/desktop/src/lib/semantic-layer/pipeline.ts` | 272 |
| `effectiveHitThreshold` | Function | `apps/desktop/src/lib/semantic-layer/config.ts` | 57 |
| `semanticRank` | Function | `apps/desktop/src/lib/ai-assist.ts` | 227 |
| `semanticRankTemplates` | Function | `apps/desktop/src/lib/ai-assist.ts` | 674 |
| `selectChunksMmr` | Function | `apps/desktop/src/lib/semantic-layer/compressor.ts` | 11 |
| `cosineSimilarity` | Function | `apps/desktop/src/lib/semantic-layer/math.ts` | 1 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `TailorDialog → IsTauri` | cross_community | 7 |
| `App → Clear` | cross_community | 6 |
| `App → IsTauri` | cross_community | 6 |
| `TemplateGallery → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → ResolveSemanticConfig` | cross_community | 6 |
| `SpaceQuickActions → EmbedText` | cross_community | 6 |
| `SpaceQuickActions → FormatCompressedContext` | cross_community | 6 |
| `CommentComposer → ResolveSemanticConfig` | cross_community | 6 |
| `CommentComposer → EmbedText` | cross_community | 6 |
| `CommentComposer → FormatCompressedContext` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Claude-chat | 4 calls |
| Workspace | 1 calls |

## How to Explore

1. `context({name: "aiCompleteStream"})` — see callers and callees
2. `query({search_query: "semantic-layer"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
