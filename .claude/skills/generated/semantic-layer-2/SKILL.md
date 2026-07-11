---
name: semantic-layer-2
description: "Skill for the Semantic_layer area of DevPrism. 32 symbols across 4 files."
---

# Semantic_layer

32 symbols | 4 files | Cohesion: 86%

## When to Use

- Working with code in `apps/`
- Understanding how lookup, store, cosine_similarity work
- Modifying semantic_layer-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | cache_ttl, max_cache_entries, hit_threshold, gray_zone_low, cache_lock (+15) |
| `apps/desktop/src-tauri/src/semantic_layer/cache.rs` | lookup, store, evict_expired, evict_lru, effective_hit_threshold (+1) |
| `apps/desktop/src-tauri/src/semantic_layer/router.rs` | score_complexity, tier_for_complexity, model_for_tier, route_query, contains_any_term |
| `apps/desktop/src-tauri/src/semantic_layer/math.rs` | cosine_similarity |

## Entry Points

Start here when exploring this area:

- **`lookup`** (Function) — `apps/desktop/src-tauri/src/semantic_layer/cache.rs:26`
- **`store`** (Function) — `apps/desktop/src-tauri/src/semantic_layer/cache.rs:91`
- **`cosine_similarity`** (Function) — `apps/desktop/src-tauri/src/semantic_layer/math.rs:1`
- **`cache_ttl`** (Function) — `apps/desktop/src-tauri/src/semantic_layer/mod.rs:45`
- **`max_cache_entries`** (Function) — `apps/desktop/src-tauri/src/semantic_layer/mod.rs:49`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `lookup` | Function | `apps/desktop/src-tauri/src/semantic_layer/cache.rs` | 26 |
| `store` | Function | `apps/desktop/src-tauri/src/semantic_layer/cache.rs` | 91 |
| `cosine_similarity` | Function | `apps/desktop/src-tauri/src/semantic_layer/math.rs` | 1 |
| `cache_ttl` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 45 |
| `max_cache_entries` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 49 |
| `hit_threshold` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 53 |
| `gray_zone_low` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 57 |
| `cache_key_for` | Function | `apps/desktop/src-tauri/src/semantic_layer/cache.rs` | 152 |
| `semantic_cache_lookup` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 100 |
| `semantic_cache_store` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 127 |
| `current_config` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 153 |
| `prepare_proxy_inference` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 161 |
| `store_proxy_cache` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 218 |
| `score_complexity` | Function | `apps/desktop/src-tauri/src/semantic_layer/router.rs` | 24 |
| `tier_for_complexity` | Function | `apps/desktop/src-tauri/src/semantic_layer/router.rs` | 64 |
| `route_query` | Function | `apps/desktop/src-tauri/src/semantic_layer/router.rs` | 91 |
| `sync_semantic_layer_config` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 90 |
| `semantic_cache_clear` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 145 |
| `extract_prompt_from_anthropic` | Function | `apps/desktop/src-tauri/src/semantic_layer/mod.rs` | 271 |
| `evict_expired` | Function | `apps/desktop/src-tauri/src/semantic_layer/cache.rs` | 125 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Prepare_proxy_inference → Native_base` | cross_community | 8 |
| `Store_proxy_cache → Native_base` | cross_community | 8 |
| `Prepare_proxy_inference → Build_client` | cross_community | 7 |
| `Store_proxy_cache → Build_client` | cross_community | 7 |
| `Prepare_proxy_inference → Contains_any_term` | cross_community | 5 |
| `Prepare_proxy_inference → New` | cross_community | 4 |
| `Prepare_proxy_inference → Default` | cross_community | 4 |
| `Prepare_proxy_inference → Looks_like_embedding` | cross_community | 4 |
| `Prepare_proxy_inference → Tier_for_complexity` | cross_community | 4 |
| `Prepare_proxy_inference → Model_for_tier` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cursor_agent | 2 calls |
| Native_agent | 2 calls |

## How to Explore

1. `context({name: "lookup"})` — see callers and callees
2. `query({search_query: "semantic_layer"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
