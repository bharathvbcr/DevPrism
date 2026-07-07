import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SEMANTIC_CONFIG,
  effectiveHitThreshold,
  SemanticCache,
  cacheKeyFor,
  scoreComplexity,
  tierForComplexity,
  routeQuery,
  selectChunksMmr,
  cosineSimilarity,
} from "@/lib/semantic-layer";

describe("effectiveHitThreshold", () => {
  it("raises threshold as cache fills", () => {
    const base = effectiveHitThreshold(DEFAULT_SEMANTIC_CONFIG, 0);
    const fuller = effectiveHitThreshold(
      DEFAULT_SEMANTIC_CONFIG,
      DEFAULT_SEMANTIC_CONFIG.maxCacheEntries,
    );
    expect(fuller).toBeGreaterThan(base);
    expect(fuller).toBeLessThanOrEqual(0.98);
  });
});

describe("SemanticCache", () => {
  let cache: SemanticCache;

  beforeEach(() => {
    cache = new SemanticCache();
  });

  it("returns exact key hits", () => {
    const key = cacheKeyFor("sys", "hello");
    const vec = [1, 0, 0];
    cache.store(key, vec, "cached reply", DEFAULT_SEMANTIC_CONFIG);
    const result = cache.lookup(vec, key, DEFAULT_SEMANTIC_CONFIG);
    expect(result.hit).toBe(true);
    expect(result.response).toBe("cached reply");
    expect(result.score).toBe(1);
  });

  it("semantic-matches paraphrases above threshold", () => {
    const vecA = [1, 0, 0];
    const vecB = [0.99, 0.01, 0];
    cache.store(
      cacheKeyFor(undefined, "What is LaTeX?"),
      vecA,
      "A typesetting system",
      DEFAULT_SEMANTIC_CONFIG,
    );
    const result = cache.lookup(
      vecB,
      cacheKeyFor(undefined, "Tell me about LaTeX"),
      DEFAULT_SEMANTIC_CONFIG,
    );
    expect(result.hit).toBe(true);
    expect(result.score).toBeGreaterThan(0.9);
  });

  it("misses in the gray zone", () => {
    const vecA = [1, 0, 0];
    const vecB = [0.88, 0.47, 0];
    cache.store(
      cacheKeyFor(undefined, "query a"),
      vecA,
      "answer",
      DEFAULT_SEMANTIC_CONFIG,
    );
    const result = cache.lookup(
      vecB,
      cacheKeyFor(undefined, "query b"),
      DEFAULT_SEMANTIC_CONFIG,
    );
    expect(result.hit).toBe(false);
    expect(result.score).toBeGreaterThan(DEFAULT_SEMANTIC_CONFIG.grayZoneLow);
    expect(result.score).toBeLessThan(DEFAULT_SEMANTIC_CONFIG.hitThreshold);
  });
});

describe("scoreComplexity", () => {
  it("scores short grammar tasks lower than long analysis", () => {
    const light = scoreComplexity("Fix this grammar typo", GRAMMAR_SYSTEM);
    const heavy = scoreComplexity(
      "Analyze and compare three architectural approaches for distributed consensus, including trade-offs and proof sketches.",
      "You are a senior architect.",
    );
    expect(light).toBeLessThan(heavy);
    expect(tierForComplexity(light)).toBe("light");
    expect(tierForComplexity(heavy)).not.toBe("light");
  });

  it("bumps JSON-format tasks slightly", () => {
    const plain = scoreComplexity("List issues", GRAMMAR_SYSTEM);
    const json = scoreComplexity("List issues", GRAMMAR_SYSTEM, "json");
    expect(json).toBeGreaterThan(plain);
  });
});

describe("routeQuery", () => {
  it("returns model override when tier model differs from default", () => {
    const config = {
      ...DEFAULT_SEMANTIC_CONFIG,
      lightModel: "phi3:mini",
      mediumModel: "llama3.2",
      heavyModel: "qwen2.5",
    };
    const decision = routeQuery("fix typo", config, "qwen2.5", {
      system: GRAMMAR_SYSTEM,
    });
    expect(decision.tier).toBe("light");
    expect(decision.modelOverride).toBe("phi3:mini");
  });

  it("returns null override when tier resolves to default", () => {
    const decision = routeQuery("hello", DEFAULT_SEMANTIC_CONFIG, "llama3.2");
    expect(decision.modelOverride).toBeNull();
  });
});

describe("selectChunksMmr", () => {
  it("prefers relevant but diverse chunks", () => {
    const query = [1, 0, 0];
    const chunks = [
      { text: "most relevant", embedding: [1, 0, 0] },
      { text: "near duplicate", embedding: [0.995, 0.05, 0] },
      { text: "different topic", embedding: [0.7, 0.71, 0] },
    ];
    const picked = selectChunksMmr(query, chunks, 2, 0.3);
    expect(picked).toHaveLength(2);
    expect(picked[0]).toBe(0);
    expect(picked[1]).toBe(2);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
});

const GRAMMAR_SYSTEM = "You are a grammar checker. Return JSON only.";
