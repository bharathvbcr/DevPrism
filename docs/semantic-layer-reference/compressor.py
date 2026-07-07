"""Semantic context compression via Maximal Marginal Relevance (MMR)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors (0 when degenerate)."""
    dot = float(np.dot(a, b))
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


@dataclass
class RagChunk:
    text: str
    embedding: np.ndarray | None = None


def select_chunks_mmr(
    query_embedding: np.ndarray,
    chunks: list[RagChunk],
    k: int,
    lambda_: float = 0.7,
) -> list[int]:
    """
    Maximal Marginal Relevance chunk selection.

    MMR(d) = λ · sim(q, d) − (1 − λ) · max_{s ∈ S} sim(d, s)

    Returns indices into `chunks`, most relevant first, up to `k`.
    Mirrors DevPrism `selectChunksMmr`.
    """
    if not chunks or k <= 0:
        return []

    relevance = [
        cosine_similarity(query_embedding, c.embedding)
        if c.embedding is not None
        else 0.0
        for c in chunks
    ]

    selected: list[int] = []
    remaining = set(range(len(chunks)))

    while len(selected) < k and remaining:
        best_idx = -1
        best_score = float("-inf")

        for idx in remaining:
            rel = relevance[idx]
            redundancy = 0.0
            for s in selected:
                a = chunks[idx].embedding
                b = chunks[s].embedding
                if a is not None and b is not None:
                    redundancy = max(redundancy, cosine_similarity(a, b))
            mmr = lambda_ * rel - (1.0 - lambda_) * redundancy
            if mmr > best_score:
                best_score = mmr
                best_idx = idx

        if best_idx < 0:
            break
        selected.append(best_idx)
        remaining.remove(best_idx)

    return selected


def filter_by_relevance(
    query_embedding: np.ndarray,
    chunks: list[RagChunk],
    *,
    min_similarity: float = 0.25,
) -> list[int]:
    """Drop chunks below a relevance floor before MMR (OOD/noise filter)."""
    return [
        i
        for i, c in enumerate(chunks)
        if c.embedding is not None
        and cosine_similarity(query_embedding, c.embedding) >= min_similarity
    ]


def format_compressed_context(chunks: list[str], label: str = "Context") -> str:
    """Join selected RAG chunks into a compressed context block."""
    if not chunks:
        return ""
    body = "\n\n".join(f"[{i + 1}] {c.strip()}" for i, c in enumerate(chunks))
    return f"{label}:\n{body}"


def compress_context(
    query_embedding: np.ndarray,
    chunks: list[str],
    chunk_embeddings: list[np.ndarray],
    *,
    max_chunks: int = 6,
    mmr_lambda: float = 0.7,
    min_similarity: float = 0.25,
) -> tuple[list[str], dict[str, int | float]]:
    """
    Filter + MMR-select RAG chunks, return selected texts and metadata.
    """
    rag = [RagChunk(text=t, embedding=e) for t, e in zip(chunks, chunk_embeddings)]
    eligible = filter_by_relevance(query_embedding, rag, min_similarity=min_similarity)
    eligible_rag = [rag[i] for i in eligible]
    indices = select_chunks_mmr(query_embedding, eligible_rag, max_chunks, mmr_lambda)

    # Map back to original indices
    original_indices = [eligible[i] for i in indices]
    selected = [chunks[i] for i in original_indices]

    return selected, {
        "input_chunks": len(chunks),
        "eligible_chunks": len(eligible),
        "selected_chunks": len(selected),
    }
