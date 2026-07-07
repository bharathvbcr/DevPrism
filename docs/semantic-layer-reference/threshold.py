"""Dynamic cosine-similarity threshold tuning for semantic cache hits."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence


@dataclass
class ThresholdConfig:
    """Configuration for cache hit threshold computation."""

    base_threshold: float = 0.92
    gray_zone_low: float = 0.85
    gray_zone_high: float = 0.92
    max_threshold: float = 0.98
    fill_penalty: float = 0.03
    max_cache_entries: int = 256


@dataclass
class ThresholdStats:
    """Rolling statistics used by the auto-tuner."""

    hits: int = 0
    misses: int = 0
    false_positive_reports: int = 0
    recent_scores: list[float] = field(default_factory=list)
    max_recent: int = 512


def effective_hit_threshold(config: ThresholdConfig, cache_size: int) -> float:
    """
    Raise the hit bar as the cache fills to reduce false positives.

    Mirrors DevPrism `effectiveHitThreshold`:
        τ_eff = min(τ_max, τ_base + (|C| / C_max) · δ)
    """
    fill = cache_size / max(1, config.max_cache_entries)
    return min(config.max_threshold, config.base_threshold + fill * config.fill_penalty)


def classify_similarity(
    score: float,
    threshold: float,
    config: ThresholdConfig,
) -> str:
    """
    Classify a similarity score into cache decision zones.

    Returns:
        "hit"     — score >= effective threshold
        "gray"    — gray_zone_low <= score < threshold (fail-open miss)
        "miss"    — score < gray_zone_low
    """
    if score >= threshold:
        return "hit"
    if score >= config.gray_zone_low:
        return "gray"
    return "miss"


def auto_tune_threshold(
    config: ThresholdConfig,
    stats: ThresholdStats,
    *,
    target_hit_rate: float = 0.25,
    max_fp_rate: float = 0.02,
    step: float = 0.005,
) -> float:
    """
    Auto-tune base threshold to balance hit rate vs false positives.

    Pseudocode:
        hit_rate  = hits / (hits + misses)
        fp_rate   = false_positives / hits
        if fp_rate > max_fp_rate:
            τ ← min(τ_max, τ + step)          # tighten — fewer hits
        elif hit_rate < target_hit_rate and fp_rate < max_fp_rate / 2:
            τ ← max(gray_zone_high, τ - step) # loosen — more hits
        return τ

    The objective minimized online is:
        J(τ) = w_fp · FP(τ) + w_miss · (1 - HR(τ)) + w_fill · fill · τ
    where FP rises when τ is too low and miss cost rises when τ is too high.
    """
    total = stats.hits + stats.misses
    if total < 20:
        return config.base_threshold

    hit_rate = stats.hits / total
    fp_rate = stats.false_positive_reports / max(1, stats.hits)

    new_base = config.base_threshold
    if fp_rate > max_fp_rate:
        new_base = min(config.max_threshold, new_base + step)
    elif hit_rate < target_hit_rate and fp_rate < max_fp_rate / 2:
        new_base = max(config.gray_zone_high, new_base - step)

    return new_base


def ood_confidence(scores: Sequence[float], *, expected_mean: float = 0.35) -> float:
    """
    Estimate out-of-distribution (OOD) confidence from nearest-neighbor scores.

    When the embedding model sees OOD text, top-1 similarities cluster near
    random baseline (~0.3–0.4 for MiniLM). Low variance + low mean → OOD.
    """
    if not scores:
        return 0.0
    mean = sum(scores) / len(scores)
    if len(scores) < 2:
        return max(0.0, 1.0 - abs(mean - expected_mean))
    variance = sum((s - mean) ** 2 for s in scores) / len(scores)
    # High variance with high max score → in-distribution
    spread = variance ** 0.5
    return min(1.0, spread * 2.0 + max(0.0, mean - expected_mean))
