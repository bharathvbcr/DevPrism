"""
Semantic Layer — Python reference implementation.

Standalone production-grade reference aligned with DevPrism patterns:
  apps/desktop/src/lib/semantic-layer/  (TypeScript)
  apps/desktop/src-tauri/src/semantic_layer/  (Rust)
"""

try:
    from .cache import SemanticCache, CacheLookupResult, cache_key_for, embed_text
    from .compressor import compress_context, format_compressed_context, select_chunks_mmr
    from .pipeline import (
        BenchmarkReport,
        PreparedInference,
        SemanticLayerConfig,
        SemanticPipeline,
        SentenceTransformerEmbedder,
    )
    from .router import ModelTier, RouterDecision, route_query, score_complexity
    from .threshold import (
        ThresholdConfig,
        auto_tune_threshold,
        classify_similarity,
        effective_hit_threshold,
        ood_confidence,
    )
except ImportError:
    from cache import SemanticCache, CacheLookupResult, cache_key_for, embed_text
    from compressor import compress_context, format_compressed_context, select_chunks_mmr
    from pipeline import (
        BenchmarkReport,
        PreparedInference,
        SemanticLayerConfig,
        SemanticPipeline,
        SentenceTransformerEmbedder,
    )
    from router import ModelTier, RouterDecision, route_query, score_complexity
    from threshold import (
        ThresholdConfig,
        auto_tune_threshold,
        classify_similarity,
        effective_hit_threshold,
        ood_confidence,
    )

__all__ = [
    "BenchmarkReport",
    "CacheLookupResult",
    "ModelTier",
    "PreparedInference",
    "RouterDecision",
    "SemanticCache",
    "SemanticLayerConfig",
    "SemanticPipeline",
    "SentenceTransformerEmbedder",
    "ThresholdConfig",
    "auto_tune_threshold",
    "cache_key_for",
    "classify_similarity",
    "compress_context",
    "effective_hit_threshold",
    "embed_text",
    "format_compressed_context",
    "ood_confidence",
    "route_query",
    "score_complexity",
    "select_chunks_mmr",
]

__version__ = "1.0.0"
