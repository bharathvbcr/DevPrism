"""Semantic router — intent/complexity-based model selection."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Literal


class ModelTier(str, Enum):
    LIGHT = "light"
    MEDIUM = "medium"
    HEAVY = "heavy"


@dataclass
class RouterConfig:
    """Model mapping per tier (1B–3B light, 8B–70B heavy)."""

    light_model: str = "phi3:mini"       # ~3.8B
    medium_model: str = "llama3.1:8b"    # ~8B
    heavy_model: str = "llama3.1:70b"    # ~70B
    light_threshold: float = 0.38
    heavy_threshold: float = 0.62


@dataclass
class RouterDecision:
    tier: ModelTier
    complexity: float
    model: str
    model_override: str | None = None


HEAVY_RE = re.compile(
    r"\b(analyze|compare|implement|refactor|architect|design|prove|"
    r"evaluate|synthesize|debug|optimize|rewrite)\b",
    re.IGNORECASE,
)
LIGHT_RE = re.compile(
    r"\b(grammar|typo|summarize|short|one line|json only|fix lint|continue after)\b",
    re.IGNORECASE,
)


def score_complexity(
    prompt: str,
    system: str | None = None,
    *,
    format: Literal["json"] | None = None,
) -> float:
    """
    Score query complexity on [0, 1]. Higher → heavier model tier.

    Aligned with DevPrism `scoreComplexity` heuristics.
    """
    text = f"{system or ''}\n{prompt}"
    score = 0.28

    length = len(text)
    if length > 2500:
        score += 0.28
    elif length > 1000:
        score += 0.18
    elif length > 400:
        score += 0.08
    elif length < 80:
        score -= 0.12

    if format == "json":
        score += 0.08
    if HEAVY_RE.search(text):
        score += 0.22
    if LIGHT_RE.search(text):
        score -= 0.18

    questions = text.count("?")
    if questions > 2:
        score += 0.10
    elif questions == 1:
        score += 0.04

    if "```" in text:
        score += 0.12
    if text.count("\n- ") >= 3:
        score += 0.06

    return max(0.0, min(1.0, score))


def tier_for_complexity(
    complexity: float,
    config: RouterConfig | None = None,
) -> ModelTier:
    cfg = config or RouterConfig()
    if complexity < cfg.light_threshold:
        return ModelTier.LIGHT
    if complexity < cfg.heavy_threshold:
        return ModelTier.MEDIUM
    return ModelTier.HEAVY


def model_for_tier(tier: ModelTier, config: RouterConfig | None = None) -> str:
    cfg = config or RouterConfig()
    return {
        ModelTier.LIGHT: cfg.light_model,
        ModelTier.MEDIUM: cfg.medium_model,
        ModelTier.HEAVY: cfg.heavy_model,
    }[tier]


def route_query(
    prompt: str,
    default_model: str,
    *,
    system: str | None = None,
    format: Literal["json"] | None = None,
    config: RouterConfig | None = None,
) -> RouterDecision:
    """
    Pick a model tier and optional override for the resolved default model.

    Simple queries (complexity < 0.38) → 1B–3B class models.
    Complex queries (complexity >= 0.62) → 8B–70B class models.
    """
    cfg = config or RouterConfig()
    complexity = score_complexity(prompt, system, format=format)
    tier = tier_for_complexity(complexity, cfg)
    resolved = model_for_tier(tier, cfg)
    model_override = resolved if resolved != default_model else None
    return RouterDecision(
        tier=tier,
        complexity=complexity,
        model=resolved,
        model_override=model_override,
    )
