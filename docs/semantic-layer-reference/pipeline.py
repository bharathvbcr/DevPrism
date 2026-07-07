"""End-to-end semantic layer pipeline orchestrator."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Protocol

import numpy as np

try:
    from .cache import SemanticCache, cache_key_for, embed_text
    from .compressor import compress_context, format_compressed_context
    from .router import RouterConfig, RouterDecision, route_query
    from .threshold import ThresholdConfig, ood_confidence
except ImportError:
    from cache import SemanticCache, cache_key_for, embed_text
    from compressor import compress_context, format_compressed_context
    from router import RouterConfig, RouterDecision, route_query
    from threshold import ThresholdConfig, ood_confidence


class Embedder(Protocol):
    """Protocol for embedding backends (sentence-transformers, Ollama, etc.)."""

    @property
    def dim(self) -> int: ...

    def encode(self, texts: list[str]) -> np.ndarray: ...


@dataclass
class SemanticLayerConfig:
    enabled: bool = True
    cache_enabled: bool = True
    router_enabled: bool = True
    compressor_enabled: bool = True
    skip_cache: bool = False
    max_rag_chunks: int = 6
    mmr_lambda: float = 0.7
    min_chunk_similarity: float = 0.25
    cache_ttl_seconds: float = 1800.0
    auto_tune_threshold: bool = False
    threshold: ThresholdConfig = field(default_factory=ThresholdConfig)
    router: RouterConfig = field(default_factory=RouterConfig)


@dataclass
class PipelineMeta:
    cache_hit: bool = False
    cache_score: float | None = None
    cache_zone: str = "miss"
    tier: str | None = None
    complexity: float | None = None
    model_used: str | None = None
    compressed_chunk_count: int | None = None
    ood_confidence: float | None = None
    elapsed_ms: float = 0.0
    phase_ms: dict[str, float] = field(default_factory=dict)


@dataclass
class PreparedInference:
    prompt: str
    system: str | None
    model: str
    meta: PipelineMeta
    cached_response: str | None = None


@dataclass
class BenchmarkReport:
    total_ms: float
    phases: dict[str, float]
    cache: dict[str, Any]
    within_budget: bool


# Type alias for downstream LLM call
LLMFn = Callable[[str, str | None, str], str]


class SentenceTransformerEmbedder:
    """Default embedder using all-MiniLM-L6-v2 (384-dim)."""

    def __init__(self, model_name: str = "sentence-transformers/all-MiniLM-L6-v2") -> None:
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(model_name)
        self.dim = self._model.get_sentence_embedding_dimension()

    def encode(self, texts: list[str]) -> np.ndarray:
        vectors = self._model.encode(
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return np.asarray(vectors, dtype=np.float32)


class SemanticPipeline:
    """
    Pre-inference semantic pass: embed → compress → cache → route.

    Fail-open: any embedding error returns original inputs unchanged.
    Target overhead: <15ms (excluding first embed cold start).
    """

    def __init__(
        self,
        embedder: Embedder,
        config: SemanticLayerConfig | None = None,
    ) -> None:
        self.embedder = embedder
        self.config = config or SemanticLayerConfig()
        self.cache = SemanticCache(
            dim=embedder.dim,
            config=self.config.threshold,
            ttl_seconds=self.config.cache_ttl_seconds,
            auto_tune=self.config.auto_tune_threshold,
        )

    def prepare(
        self,
        prompt: str,
        *,
        system: str | None = None,
        default_model: str = "llama3.1:8b",
        context_chunks: list[str] | None = None,
        format: Literal["json"] | None = None,
    ) -> PreparedInference:
        """Run the semantic layer before LLM inference."""
        started = time.perf_counter()
        meta = PipelineMeta()
        phases: dict[str, float] = {}

        if not self.config.enabled:
            meta.elapsed_ms = (time.perf_counter() - started) * 1000
            return PreparedInference(
                prompt=prompt,
                system=system,
                model=default_model,
                meta=meta,
            )

        working_prompt = prompt
        model = default_model

        try:
            # --- Phase 1: Embed query (+ optional RAG chunks) ---
            t0 = time.perf_counter()
            embed_texts = [embed_text(system, prompt)]
            chunks = [c for c in (context_chunks or []) if c.strip()]
            if self.config.compressor_enabled and chunks:
                embed_texts.extend(chunks)

            vectors = self.embedder.encode(embed_texts)
            if len(vectors) != len(embed_texts):
                raise ValueError("Unexpected embedding batch size")

            query_vec = vectors[0]
            chunk_vecs = vectors[1:] if chunks else []
            phases["embed"] = (time.perf_counter() - t0) * 1000

            # --- Phase 2: Compress RAG context ---
            if self.config.compressor_enabled and chunks and len(chunk_vecs) > 0:
                t0 = time.perf_counter()
                selected, comp_meta = compress_context(
                    query_vec,
                    chunks,
                    list(chunk_vecs),
                    max_chunks=self.config.max_rag_chunks,
                    mmr_lambda=self.config.mmr_lambda,
                    min_similarity=self.config.min_chunk_similarity,
                )
                meta.compressed_chunk_count = comp_meta["selected_chunks"]
                block = format_compressed_context(selected)
                if block:
                    working_prompt = f"{block}\n\n{prompt}"
                phases["compress"] = (time.perf_counter() - t0) * 1000

            # --- Phase 3: Semantic cache lookup ---
            if self.config.cache_enabled and not self.config.skip_cache:
                t0 = time.perf_counter()
                key = cache_key_for(system, working_prompt)
                lookup = self.cache.lookup(query_vec, key)
                meta.cache_hit = lookup.hit
                meta.cache_score = lookup.score
                meta.cache_zone = lookup.zone
                phases["cache"] = (time.perf_counter() - t0) * 1000

                if lookup.hit and lookup.response:
                    meta.elapsed_ms = (time.perf_counter() - started) * 1000
                    meta.phase_ms = phases
                    return PreparedInference(
                        prompt=working_prompt,
                        system=system,
                        model=model,
                        cached_response=lookup.response,
                        meta=meta,
                    )

                # OOD detection from recent neighbor scores
                if self.cache.stats.recent_scores:
                    meta.ood_confidence = ood_confidence(
                        self.cache.stats.recent_scores[-5:]
                    )

            # --- Phase 4: Route to appropriate model tier ---
            if self.config.router_enabled:
                t0 = time.perf_counter()
                decision = route_query(
                    working_prompt,
                    default_model,
                    system=system,
                    format=format,
                    config=self.config.router,
                )
                meta.tier = decision.tier.value
                meta.complexity = decision.complexity
                if decision.model_override:
                    model = decision.model_override
                meta.model_used = model
                phases["route"] = (time.perf_counter() - t0) * 1000

        except Exception:
            # Fail-open to inference on any semantic-layer error.
            pass

        meta.elapsed_ms = (time.perf_counter() - started) * 1000
        meta.phase_ms = phases
        return PreparedInference(
            prompt=working_prompt,
            system=system,
            model=model,
            meta=meta,
        )

    def store(
        self,
        prompt: str,
        response: str,
        *,
        system: str | None = None,
    ) -> None:
        """Store a successful inference result in the semantic cache."""
        if not self.config.enabled or not self.config.cache_enabled:
            return
        try:
            key = cache_key_for(system, prompt)
            vec = self.embedder.encode([embed_text(system, prompt)])[0]
            self.cache.store(key, vec, response)
        except Exception:
            pass  # Best-effort cache write.

    def run(
        self,
        prompt: str,
        llm: LLMFn,
        *,
        system: str | None = None,
        default_model: str = "llama3.1:8b",
        context_chunks: list[str] | None = None,
    ) -> tuple[str, PipelineMeta]:
        """Full pipeline: prepare → LLM (if miss) → store."""
        prepared = self.prepare(
            prompt,
            system=system,
            default_model=default_model,
            context_chunks=context_chunks,
        )
        if prepared.cached_response is not None:
            return prepared.cached_response, prepared.meta

        response = llm(prepared.prompt, prepared.system, prepared.model)
        self.store(prepared.prompt, response, system=system)
        return response, prepared.meta

    def benchmark(
        self,
        queries: list[str],
        *,
        system: str | None = None,
        budget_ms: float = 15.0,
    ) -> BenchmarkReport:
        """Benchmark semantic layer overhead across representative queries."""
        phase_totals: dict[str, float] = {}
        for q in queries:
            prepared = self.prepare(q, system=system)
            for phase, ms in prepared.meta.phase_ms.items():
                phase_totals[phase] = phase_totals.get(phase, 0.0) + ms

        n = max(1, len(queries))
        avg_phases = {k: v / n for k, v in phase_totals.items()}
        total_avg = sum(avg_phases.values())
        return BenchmarkReport(
            total_ms=round(total_avg, 3),
            phases={k: round(v, 3) for k, v in avg_phases.items()},
            cache=self.cache.benchmark_summary(),
            within_budget=total_avg <= budget_ms,
        )


def demo_llm(prompt: str, system: str | None, model: str) -> str:
    """Stub LLM for runnable demo."""
    return f"[{model}] Response to: {prompt[:80]}..."


def main() -> None:
    """Runnable entry point for quick validation."""
    print("Loading embedder (first run downloads ~90MB model)...")
    embedder = SentenceTransformerEmbedder()
    pipeline = SemanticPipeline(embedder)

    queries = [
        "Fix grammar: teh cat sat on teh mat",
        "Summarize this in one line: quantum computing uses qubits.",
        "Analyze and compare microservice vs monolith architectures for a fintech startup.",
    ]

    for q in queries:
        response, meta = pipeline.run(q, demo_llm)
        print(f"\nQ: {q[:60]}...")
        print(f"  tier={meta.tier} complexity={meta.complexity}")
        print(f"  cache_hit={meta.cache_hit} elapsed={meta.elapsed_ms:.1f}ms")
        print(f"  response={response[:100]}...")

    # Second pass — cache hits
    print("\n--- Cache replay ---")
    for q in queries[:2]:
        _, meta = pipeline.run(q, demo_llm)
        print(f"  '{q[:40]}...' cache_hit={meta.cache_hit} score={meta.cache_score}")

    report = pipeline.benchmark(queries)
    print(f"\nBenchmark: {report.total_ms}ms avg (budget 15ms: {report.within_budget})")
    print(f"  phases: {report.phases}")
    print(f"  cache:  {report.cache}")


if __name__ == "__main__":
    main()
