import { cosineSimilarity } from "@/lib/semantic-layer/math";

export interface RagChunk {
  text: string;
  embedding?: number[];
}

/**
 * Maximal Marginal Relevance chunk selection.
 * Returns indices into `chunks`, most relevant first, up to `k`.
 */
export function selectChunksMmr(
  queryEmbedding: number[],
  chunks: RagChunk[],
  k: number,
  lambda = 0.7,
): number[] {
  if (chunks.length === 0 || k <= 0) return [];

  const relevance = chunks.map((c) =>
    c.embedding ? cosineSimilarity(queryEmbedding, c.embedding) : 0,
  );

  const selected: number[] = [];
  const remaining = new Set(chunks.map((_, i) => i));

  while (selected.length < k && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const idx of remaining) {
      const rel = relevance[idx];
      let redundancy = 0;
      for (const s of selected) {
        const a = chunks[idx].embedding;
        const b = chunks[s].embedding;
        if (a && b) {
          redundancy = Math.max(redundancy, cosineSimilarity(a, b));
        }
      }
      const mmr = lambda * rel - (1 - lambda) * redundancy;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = idx;
      }
    }

    if (bestIdx < 0) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selected;
}

/** Join selected RAG chunks into a compressed context block. */
export function formatCompressedContext(
  chunks: string[],
  label = "Context",
): string {
  if (chunks.length === 0) return "";
  return `${label}:\n${chunks.map((c, i) => `[${i + 1}] ${c.trim()}`).join("\n\n")}`;
}
