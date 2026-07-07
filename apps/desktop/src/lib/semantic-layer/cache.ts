import {
  type SemanticLayerConfig,
  effectiveHitThreshold,
} from "@/lib/semantic-layer/config";
import { cosineSimilarity } from "@/lib/semantic-layer/math";

export interface CacheEntry {
  cacheKey: string;
  embedding: number[];
  response: string;
  createdAt: number;
  lastAccessed: number;
}

export interface CacheLookupResult {
  hit: boolean;
  response?: string;
  score?: number;
}

/** Stable key for exact dedup within the TTL window. */
export function cacheKeyFor(
  system: string | undefined,
  prompt: string,
): string {
  return `${system ?? ""}\0${prompt}`;
}

export class SemanticCache {
  private entries = new Map<string, CacheEntry>();

  size(): number {
    return this.entries.size;
  }

  lookup(
    embedding: number[],
    cacheKey: string,
    config: SemanticLayerConfig,
  ): CacheLookupResult {
    const now = Date.now();
    this.evictExpired(now, config.cacheTtlMs);

    const exact = this.entries.get(cacheKey);
    if (exact && now - exact.createdAt <= config.cacheTtlMs) {
      exact.lastAccessed = now;
      return { hit: true, response: exact.response, score: 1 };
    }

    const threshold = effectiveHitThreshold(config, this.entries.size);
    let best: { entry: CacheEntry; score: number } | null = null;

    for (const entry of this.entries.values()) {
      if (now - entry.createdAt > config.cacheTtlMs) continue;
      const score = cosineSimilarity(embedding, entry.embedding);
      if (!best || score > best.score) {
        best = { entry, score };
      }
    }

    if (!best) return { hit: false };

    if (best.score >= threshold) {
      best.entry.lastAccessed = now;
      return { hit: true, response: best.entry.response, score: best.score };
    }

    if (best.score < config.grayZoneLow) {
      return { hit: false, score: best.score };
    }

    // Gray zone — ambiguous; fail open to inference.
    return { hit: false, score: best.score };
  }

  store(
    cacheKey: string,
    embedding: number[],
    response: string,
    config: SemanticLayerConfig,
  ): void {
    const now = Date.now();
    this.evictExpired(now, config.cacheTtlMs);

    const existing = this.entries.get(cacheKey);
    if (existing) {
      existing.embedding = embedding;
      existing.response = response;
      existing.createdAt = now;
      existing.lastAccessed = now;
      return;
    }

    while (this.entries.size >= config.maxCacheEntries) {
      this.evictLru();
    }

    this.entries.set(cacheKey, {
      cacheKey,
      embedding,
      response,
      createdAt: now,
      lastAccessed: now,
    });
  }

  clear(): void {
    this.entries.clear();
  }

  private evictExpired(now: number, ttlMs: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictLru(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccessed < oldestAccess) {
        oldestAccess = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey) this.entries.delete(oldestKey);
  }
}

/** Module singleton — survives for the app session. */
export const semanticCache = new SemanticCache();
