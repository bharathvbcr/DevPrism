# Semantic Layer — Production Architecture Blueprint

> **Status:** Reference architecture aligned with DevPrism in-progress implementation  
> **Reference code:** [`docs/semantic-layer-reference/`](semantic-layer-reference/)  
> **DevPrism canonical:** `apps/desktop/src/lib/semantic-layer/` (TS) · `apps/desktop/src-tauri/src/semantic_layer/` (Rust)

---

## System Architecture & Data Flow

The Semantic Layer sits **before** the target LLM inference engine as a fail-open pre-processing pass. It reduces latency (cache), cost (routing), and context bloat (compression) while preserving answer quality.

### End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INCOMING QUERY                                     │
│              (prompt, system, optional RAG chunks, default model)            │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │   0. GATE — enabled?         │
                    │   skip → passthrough         │
                    └──────────────┬───────────────┘
                                   │ enabled
                                   ▼
                    ┌──────────────────────────────┐
                    │   1. EMBED (MiniLM / Ollama) │
                    │   query + RAG chunk vectors  │
                    │   ~3–8ms (warm CPU)          │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │   2. SEMANTIC COMPRESSOR     │
                    │   relevance filter + MMR     │
                    │   λ=0.7, max 6 chunks        │
                    │   ~0.5ms                     │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
          ┌────────────────────────────────────────────────┐
          │   3. SEMANTIC CACHE (FAISS interceptor)        │
          │   a) exact key hit (system\0prompt) → return   │
          │   b) FAISS top-k cosine search                 │
          │   c) threshold / gray-zone decision            │
          │   HIT → return cached response (skip LLM)      │
          │   ~1–5ms                                     │
          └────────────────────┬───────────────────────────┘
                               │ MISS (or gray-zone fail-open)
                               ▼
          ┌────────────────────────────────────────────────┐
          │   4. SEMANTIC ROUTER                         │
          │   complexity score ∈ [0,1]                   │
          │   <0.38 → light (1B–3B)                      │
          │   0.38–0.62 → medium (8B)                    │
          │   ≥0.62 → heavy (8B–70B)                     │
          │   ~0.1ms                                     │
          └────────────────────┬───────────────────────────┘
                               │
                               ▼
          ┌────────────────────────────────────────────────┐
          │   5. TARGET LLM INFERENCE ENGINE               │
          │   (Ollama / Anthropic proxy / vLLM)            │
          └────────────────────┬───────────────────────────┘
                               │ success
                               ▼
          ┌────────────────────────────────────────────────┐
          │   6. CACHE STORE (async / best-effort)         │
          │   embed + FAISS add + TTL/LRU bookkeeping      │
          └────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Role | DevPrism module | Target latency |
|-----------|------|-----------------|----------------|
| **Embedder** | Vectorize query + chunks | Ollama embed / ST MiniLM | 3–8 ms |
| **Compressor** | MMR chunk selection | `compressor.ts` | <1 ms |
| **Cache** | Exact + semantic dedup | `cache.ts` / `cache.rs` | 1–5 ms |
| **Router** | Complexity → model tier | `router.ts` / `router.rs` | <0.5 ms |
| **Pipeline** | Orchestrator, fail-open | `pipeline.ts` / `mod.rs` | **<15 ms total** |

### Fail-Open Contract

Every stage must degrade gracefully:

1. Embedding failure → skip cache/compress, pass original prompt to LLM.
2. Cache gray zone (0.85–0.92 similarity) → treat as **miss**, never serve ambiguous hits.
3. Router disabled → use caller's default model.
4. Post-inference cache store → best-effort, never block response delivery.

This mirrors DevPrism's `prepareSemanticInference` try/catch and gray-zone logic.

### Alignment with DevPrism

| Pattern | DevPrism | Python reference |
|---------|----------|------------------|
| Cache key | `system\0prompt` | `cache_key_for()` |
| Embed text | `system\n---\nprompt` | `embed_text()` |
| Hit threshold | 0.92 + fill×0.03 | `effective_hit_threshold()` |
| Gray zone | [0.85, 0.92) → miss | `classify_similarity()` |
| MMR λ | 0.7 | `select_chunks_mmr()` |
| Complexity tiers | 0.38 / 0.62 | `tier_for_complexity()` |
| TTL / LRU | 30 min / 256 entries | `SemanticCache` |
| Shared cache | Tauri IPC | N/A (in-process FAISS) |

---

## Mathematical Optimization & Thresholding Logic

### Cosine Similarity

For L2-normalized embeddings **q**, **d**:

```
sim(q, d) = q · d = cos(θ)
```

FAISS `IndexFlatIP` on normalized vectors computes this in O(n) for n cache entries. At 256 entries, brute-force IP is <1 ms on modern CPU.

### Dynamic Hit Threshold

As cache fill increases, collision probability rises. DevPrism raises the bar dynamically:

```
τ_eff = min(τ_max, τ_base + (|C| / C_max) · δ)

where:
  τ_base = 0.92        (base threshold)
  τ_max  = 0.98        (ceiling)
  δ      = 0.03        (fill penalty)
  C_max  = 256         (max entries)
```

**Pseudocode — lookup decision:**

```
function LOOKUP(query_vec, cache_key):
    if EXACT_MATCH(cache_key):
        return HIT(score=1.0)

    (score, entry) = FAISS_TOP1(query_vec)
    τ = effective_hit_threshold(|C|)

    if score >= τ:
        return HIT(score)
    elif score >= gray_zone_low:    # 0.85
        return MISS_GRAY(score)     # fail-open
    else:
        return MISS(score)
```

### Auto-Tuning Threshold

Online adjustment balances hit rate (HR) vs false-positive rate (FP):

```
J(τ) = w_fp · FP(τ) + w_miss · (1 - HR(τ)) + w_fill · fill · τ

Pseudocode:
    hit_rate = hits / (hits + misses)
    fp_rate  = false_positives / hits

    if fp_rate > max_fp_rate:           # default 2%
        τ_base ← min(τ_max, τ_base + step)
    elif hit_rate < target_hit_rate      # default 25%
         and fp_rate < max_fp_rate / 2:
        τ_base ← max(gray_zone_high, τ_base - step)
```

Implementation: `threshold.py` → `auto_tune_threshold()`.

### MMR Compression

Maximal Marginal Relevance selects diverse, relevant chunks:

```
MMR(dᵢ) = λ · sim(q, dᵢ) − (1 − λ) · max_{dⱼ ∈ S} sim(dᵢ, dⱼ)

λ = 0.7  →  favor relevance over diversity
```

Pre-filter chunks where `sim(q, d) < 0.25` to drop OOD/noise before MMR.

### Complexity Routing

Heuristic score (aligned with DevPrism `scoreComplexity`):

```
score = 0.28
      + f_length(text)
      + 0.22 · I(heavy_terms)
      − 0.18 · I(light_terms)
      + 0.12 · I(has_code_fence)
      + ...

tier = LIGHT   if score < 0.38
     = MEDIUM  if score < 0.62
     = HEAVY   otherwise
```

| Tier | Model class | Example |
|------|-------------|---------|
| Light | 1B–3B | phi3:mini, gemma:2b |
| Medium | 8B | llama3.1:8b |
| Heavy | 8B–70B | llama3.1:70b, claude-sonnet |

---

## Production-Grade Python Implementation (Modular, commented, and type-hinted)

### Directory Layout

```
docs/semantic-layer-reference/
├── __init__.py          # Public API exports
├── cache.py             # FAISS semantic cache (TTL, LRU, gray zone)
├── router.py            # Complexity-based model routing
├── compressor.py        # MMR context compression
├── threshold.py         # Dynamic threshold + auto-tuning + OOD detection
├── pipeline.py          # Orchestrator + embedder + benchmark hooks
└── requirements.txt
```

### Quick Start

```bash
cd docs/semantic-layer-reference
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m pipeline
```

### Usage

```python
from pipeline import SemanticPipeline, SentenceTransformerEmbedder

embedder = SentenceTransformerEmbedder()
pipeline = SemanticPipeline(embedder)

prepared = pipeline.prepare(
    "Analyze microservice trade-offs for payments",
    system="You are a senior architect.",
    default_model="llama3.1:8b",
    context_chunks=["chunk1...", "chunk2..."],
)

if prepared.cached_response:
    print(prepared.cached_response)  # cache hit — skip LLM
else:
    # invoke LLM with prepared.prompt, prepared.model
    response = my_llm(prepared.prompt, prepared.model)
    pipeline.store(prepared.prompt, response, system="You are a senior architect.")
```

### Benchmark Hooks

```python
report = pipeline.benchmark(
    ["Fix typo: teh", "Analyze CAP theorem"],
    budget_ms=15.0,
)
print(report.total_ms, report.phases, report.cache)
print("Within budget:", report.within_budget)
```

`SemanticCache.benchmark_summary()` reports p50/p99 lookup latency and hit rate.

---

## Resource Management & Benchmarking Strategy (VRAM/CPU/Latency)

### Latency Budget (<15 ms semantic overhead)

| Phase | Warm CPU | Cold start | Notes |
|-------|----------|------------|-------|
| Embed (MiniLM) | 3–8 ms | 200–500 ms | Model load once |
| Compress (MMR) | <1 ms | <1 ms | Pure NumPy |
| Cache (FAISS 256) | 1–3 ms | 1–3 ms | IndexFlatIP |
| Router | <0.5 ms | <0.5 ms | Regex heuristics |
| **Total** | **5–12 ms** | — | Within budget |

> First query after process start pays model load cost. Pre-warm embedder at startup.

### VRAM / CPU Contention

The embedding model and primary LLM compete for GPU memory on single-GPU setups.

**Mitigation strategies:**

| Strategy | When | Implementation |
|----------|------|----------------|
| **CPU embedder** | Default for MiniLM (~90 MB RAM) | `SentenceTransformer(device="cpu")` |
| **Quantized LLM on GPU** | LLM needs VRAM | 4-bit/8-bit GGUF via Ollama |
| **Sequential scheduling** | Same GPU | Embed on CPU → release → LLM on GPU |
| **Dedicated embed pod** | Production | Sidecar service, gRPC embed API |
| **Batch embed amortization** | RAG-heavy | Batch query + chunks in one encode() |

DevPrism Rust path uses Ollama's embedding endpoint (CPU or shared GPU pool), keeping the proxy path decoupled from LLM VRAM.

### Cache Eviction Policy

```
TTL:  30 minutes (configurable)
LRU:  evict least-recently-accessed when |C| >= 256
```

Expired entries removed on every lookup/store. FAISS IDs recycled via `IndexIDMap2`.

### Benchmarking Checklist

1. **Warm-up:** 10 dummy embeds before timing.
2. **Phase breakdown:** `pipeline.prepare()` → `meta.phase_ms`.
3. **Cache hit rate:** Run query set twice; measure second-pass hits.
4. **Threshold sweep:** Plot HR vs FP at τ ∈ [0.80, 0.98].
5. **OOD injection:** Random unicode / code-switching text → verify gray-zone misses.
6. **Contention test:** Run embed + LLM concurrently; compare p99 latency.

### Edge Cases

#### OOD Queries Degrading Embedding Model

Out-of-distribution text (random tokens, adversarial unicode, domain mismatch) produces embeddings with low, high-variance neighbor scores.

**Detection:** `ood_confidence()` — low mean + low spread of recent top-k scores.  
**Response:** Widen gray zone (treat as miss), skip cache store, optionally force heavy tier.

#### Cold Starts (Empty Cache)

- First query always misses cache → full LLM latency.
- Pre-populate with FAQ embeddings for known hot paths.
- Exact-key dedup still helps repeated identical prompts within TTL.

#### Hardware Resource Contention

- Pin MiniLM to CPU threads (`torch.set_num_threads(4)`).
- Use `faiss-cpu` (not GPU) for ≤10k entries — GPU transfer overhead exceeds search savings.
- Monitor with `BenchmarkReport.within_budget` flag in CI.

---

## DevPrism Integration Notes

The Python reference is **standalone** for portability. To integrate into DevPrism:

1. **Frontend path:** Already wired via `prepareSemanticInference()` → Tauri IPC for shared cache.
2. **Proxy path:** Rust `prepare_proxy_inference()` handles Anthropic proxy requests.
3. **Embedding:** DevPrism uses Ollama; Python reference uses sentence-transformers — swap `Embedder` protocol impl.
4. **Settings:** Map `SemanticLayerConfig` fields to `settings-store` toggles (`semanticLayerEnabled`, tier models, etc.).

Future: expose Python reference as optional sidecar for batch/RAG-heavy workloads while keeping <15 ms in-process path in TS/Rust.

---

## Appendix: Configuration Defaults

```yaml
semantic_layer:
  enabled: false          # opt-in (DevPrism default)
  cache_enabled: true
  router_enabled: true
  compressor_enabled: true
  max_cache_entries: 256
  cache_ttl_seconds: 1800
  hit_threshold: 0.92
  gray_zone_low: 0.85
  gray_zone_high: 0.92
  max_rag_chunks: 6
  mmr_lambda: 0.7
  min_chunk_similarity: 0.25
  light_model: phi3:mini
  medium_model: llama3.1:8b
  heavy_model: llama3.1:70b
```

---

*Document version 1.0 — aligned with DevPrism semantic layer as of 2026-07.*
