"""Semantic cache backed by FAISS with TTL and LRU eviction."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import RLock
from typing import Any

import faiss
import numpy as np

try:
    from .threshold import (
        ThresholdConfig,
        ThresholdStats,
        auto_tune_threshold,
        classify_similarity,
        effective_hit_threshold,
    )
except ImportError:
    from threshold import (
        ThresholdConfig,
        ThresholdStats,
        auto_tune_threshold,
        classify_similarity,
        effective_hit_threshold,
    )


def cache_key_for(system: str | None, prompt: str) -> str:
    """Stable key for exact dedup within the TTL window (DevPrism convention)."""
    return f"{system or ''}\0{prompt}"


def embed_text(system: str | None, prompt: str) -> str:
    """Canonical text form embedded for cache lookup."""
    sys = (system or "").strip()
    return f"{sys}\n---\n{prompt}" if sys else prompt


@dataclass
class CacheEntry:
    cache_key: str
    faiss_id: int
    embedding: np.ndarray
    response: str
    created_at: float
    last_accessed: float


@dataclass
class CacheLookupResult:
    hit: bool
    response: str | None = None
    score: float | None = None
    zone: str = "miss"


@dataclass
class CacheMetrics:
    lookups: int = 0
    hits: int = 0
    exact_hits: int = 0
    semantic_hits: int = 0
    gray_zone_misses: int = 0
    lookup_latency_ms: list[float] = field(default_factory=list)


class SemanticCache:
    """
    Low-latency semantic cache using FAISS IndexIDMap2 + IndexFlatIP.

    Vectors are L2-normalized so inner product equals cosine similarity.
    Target lookup latency: <5ms for 256 entries on CPU.
    """

    def __init__(
        self,
        dim: int,
        config: ThresholdConfig | None = None,
        *,
        ttl_seconds: float = 1800.0,
        auto_tune: bool = False,
    ) -> None:
        self.dim = dim
        self.config = config or ThresholdConfig()
        self.ttl_seconds = ttl_seconds
        self.auto_tune = auto_tune
        self._entries: dict[str, CacheEntry] = {}
        self._faiss_id_to_key: dict[int, str] = {}
        self._next_id = 0
        base = faiss.IndexFlatIP(dim)
        self._index = faiss.IndexIDMap2(base)
        self._lock = RLock()
        self.stats = ThresholdStats()
        self.metrics = CacheMetrics()

    @property
    def size(self) -> int:
        return len(self._entries)

    def _normalize(self, vec: np.ndarray) -> np.ndarray:
        v = vec.astype(np.float32).reshape(1, -1)
        faiss.normalize_L2(v)
        return v[0]

    def _evict_expired(self, now: float) -> None:
        expired = [
            k
            for k, e in self._entries.items()
            if now - e.created_at > self.ttl_seconds
        ]
        for key in expired:
            self._remove_entry(key)

    def _remove_entry(self, key: str) -> None:
        entry = self._entries.pop(key, None)
        if entry is None:
            return
        self._faiss_id_to_key.pop(entry.faiss_id, None)
        self._index.remove_ids(np.array([entry.faiss_id], dtype=np.int64))

    def _evict_lru(self) -> None:
        if not self._entries:
            return
        oldest_key = min(self._entries, key=lambda k: self._entries[k].last_accessed)
        self._remove_entry(oldest_key)

    def _allocate_id(self) -> int:
        faiss_id = self._next_id
        self._next_id += 1
        return faiss_id

    def lookup(
        self,
        embedding: np.ndarray,
        cache_key: str,
        *,
        k: int = 5,
    ) -> CacheLookupResult:
        """Look up a cached response by exact key or semantic similarity."""
        started = time.perf_counter()

        with self._lock:
            now = time.time()
            self._evict_expired(now)
            self.metrics.lookups += 1

            exact = self._entries.get(cache_key)
            if exact and now - exact.created_at <= self.ttl_seconds:
                exact.last_accessed = now
                self.metrics.hits += 1
                self.metrics.exact_hits += 1
                self.stats.hits += 1
                self._record_latency(started)
                return CacheLookupResult(
                    hit=True, response=exact.response, score=1.0, zone="hit"
                )

            if self._index.ntotal == 0:
                self.stats.misses += 1
                self._record_latency(started)
                return CacheLookupResult(hit=False)

            query = self._normalize(embedding).reshape(1, -1)
            threshold = effective_hit_threshold(self.config, self.size)
            search_k = min(k, self._index.ntotal)
            scores, ids = self._index.search(query, search_k)

            best_score = float(scores[0][0]) if search_k > 0 else 0.0
            best_id = int(ids[0][0]) if search_k > 0 and ids[0][0] >= 0 else -1

            zone = classify_similarity(best_score, threshold, self.config)

            if zone == "hit" and best_id >= 0:
                hit_key = self._faiss_id_to_key.get(best_id)
                entry = self._entries.get(hit_key) if hit_key else None
                if entry and now - entry.created_at <= self.ttl_seconds:
                    entry.last_accessed = now
                    self.metrics.hits += 1
                    self.metrics.semantic_hits += 1
                    self.stats.hits += 1
                    self.stats.recent_scores.append(best_score)
                    self._record_latency(started)
                    return CacheLookupResult(
                        hit=True,
                        response=entry.response,
                        score=best_score,
                        zone="hit",
                    )

            if zone == "gray":
                self.metrics.gray_zone_misses += 1

            self.stats.misses += 1
            if best_score > 0:
                self.stats.recent_scores.append(best_score)
            self._record_latency(started)
            return CacheLookupResult(hit=False, score=best_score, zone=zone)

    def store(
        self,
        cache_key: str,
        embedding: np.ndarray,
        response: str,
    ) -> None:
        """Store a query embedding and its LLM response."""
        with self._lock:
            now = time.time()
            self._evict_expired(now)
            norm = self._normalize(embedding)

            if cache_key in self._entries:
                old = self._entries[cache_key]
                self._index.remove_ids(np.array([old.faiss_id], dtype=np.int64))
                self._faiss_id_to_key.pop(old.faiss_id, None)
                faiss_id = old.faiss_id
            else:
                while self.size >= self.config.max_cache_entries:
                    self._evict_lru()
                faiss_id = self._allocate_id()

            self._index.add_with_ids(
                norm.reshape(1, -1),
                np.array([faiss_id], dtype=np.int64),
            )
            self._faiss_id_to_key[faiss_id] = cache_key
            self._entries[cache_key] = CacheEntry(
                cache_key=cache_key,
                faiss_id=faiss_id,
                embedding=norm,
                response=response,
                created_at=now,
                last_accessed=now,
            )

            if self.auto_tune and (self.stats.hits + self.stats.misses) % 50 == 0:
                self.config.base_threshold = auto_tune_threshold(
                    self.config, self.stats
                )

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._faiss_id_to_key.clear()
            self._next_id = 0
            base = faiss.IndexFlatIP(self.dim)
            self._index = faiss.IndexIDMap2(base)

    def report_false_positive(self) -> None:
        """Caller signals a cache hit was wrong — feeds auto-tuner."""
        self.stats.false_positive_reports += 1

    def _record_latency(self, started: float) -> None:
        ms = (time.perf_counter() - started) * 1000.0
        self.metrics.lookup_latency_ms.append(ms)
        if len(self.metrics.lookup_latency_ms) > 1000:
            self.metrics.lookup_latency_ms = self.metrics.lookup_latency_ms[-500:]

    def benchmark_summary(self) -> dict[str, Any]:
        latencies = self.metrics.lookup_latency_ms
        p50 = float(np.percentile(latencies, 50)) if latencies else 0.0
        p99 = float(np.percentile(latencies, 99)) if latencies else 0.0
        return {
            "size": self.size,
            "lookups": self.metrics.lookups,
            "hit_rate": self.metrics.hits / max(1, self.metrics.lookups),
            "exact_hits": self.metrics.exact_hits,
            "semantic_hits": self.metrics.semantic_hits,
            "gray_zone_misses": self.metrics.gray_zone_misses,
            "latency_p50_ms": round(p50, 3),
            "latency_p99_ms": round(p99, 3),
            "threshold": effective_hit_threshold(self.config, self.size),
        }
