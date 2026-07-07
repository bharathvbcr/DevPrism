---
name: semantic-layer-reference
description: "Skill for the Semantic-layer-reference area of DevPrism. 28 symbols across 5 files."
---

# Semantic-layer-reference

28 symbols | 5 files | Cohesion: 94%

## When to Use

- Working with code in `docs/`
- Understanding how effective_hit_threshold, classify_similarity, auto_tune_threshold work
- Modifying semantic-layer-reference-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `docs/semantic-layer-reference/cache.py` | _normalize, _evict_expired, _remove_entry, _evict_lru, _allocate_id (+6) |
| `docs/semantic-layer-reference/compressor.py` | format_compressed_context, cosine_similarity, select_chunks_mmr, filter_by_relevance, compress_context |
| `docs/semantic-layer-reference/pipeline.py` | prepare, store, run, benchmark, main |
| `docs/semantic-layer-reference/router.py` | score_complexity, tier_for_complexity, model_for_tier, route_query |
| `docs/semantic-layer-reference/threshold.py` | effective_hit_threshold, classify_similarity, auto_tune_threshold |

## Entry Points

Start here when exploring this area:

- **`effective_hit_threshold`** (Function) — `docs/semantic-layer-reference/threshold.py:31`
- **`classify_similarity`** (Function) — `docs/semantic-layer-reference/threshold.py:42`
- **`auto_tune_threshold`** (Function) — `docs/semantic-layer-reference/threshold.py:62`
- **`cache_key_for`** (Function) — `docs/semantic-layer-reference/cache.py:30`
- **`embed_text`** (Function) — `docs/semantic-layer-reference/cache.py:35`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `effective_hit_threshold` | Function | `docs/semantic-layer-reference/threshold.py` | 31 |
| `classify_similarity` | Function | `docs/semantic-layer-reference/threshold.py` | 42 |
| `auto_tune_threshold` | Function | `docs/semantic-layer-reference/threshold.py` | 62 |
| `cache_key_for` | Function | `docs/semantic-layer-reference/cache.py` | 30 |
| `embed_text` | Function | `docs/semantic-layer-reference/cache.py` | 35 |
| `format_compressed_context` | Function | `docs/semantic-layer-reference/compressor.py` | 92 |
| `main` | Function | `docs/semantic-layer-reference/pipeline.py` | 309 |
| `cosine_similarity` | Function | `docs/semantic-layer-reference/compressor.py` | 9 |
| `select_chunks_mmr` | Function | `docs/semantic-layer-reference/compressor.py` | 25 |
| `filter_by_relevance` | Function | `docs/semantic-layer-reference/compressor.py` | 77 |
| `compress_context` | Function | `docs/semantic-layer-reference/compressor.py` | 100 |
| `score_complexity` | Function | `docs/semantic-layer-reference/router.py` | 46 |
| `tier_for_complexity` | Function | `docs/semantic-layer-reference/router.py` | 91 |
| `model_for_tier` | Function | `docs/semantic-layer-reference/router.py` | 103 |
| `route_query` | Function | `docs/semantic-layer-reference/router.py` | 112 |
| `lookup` | Method | `docs/semantic-layer-reference/cache.py` | 134 |
| `store` | Method | `docs/semantic-layer-reference/cache.py` | 201 |
| `benchmark_summary` | Method | `docs/semantic-layer-reference/cache.py` | 260 |
| `prepare` | Method | `docs/semantic-layer-reference/pipeline.py` | 123 |
| `store` | Method | `docs/semantic-layer-reference/pipeline.py` | 239 |

## How to Explore

1. `context({name: "effective_hit_threshold"})` — see callers and callees
2. `query({search_query: "semantic-layer-reference"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
