import { useSettingsStore } from "@/stores/settings-store";

export type ModelTier = "light" | "medium" | "heavy";

export interface SemanticLayerConfig {
  enabled: boolean;
  cacheEnabled: boolean;
  routerEnabled: boolean;
  compressorEnabled: boolean;
  maxCacheEntries: number;
  cacheTtlMs: number;
  /** Minimum cosine similarity for a definite cache hit. */
  hitThreshold: number;
  /** Below this similarity is always a miss. */
  grayZoneLow: number;
  /** Between grayZoneLow and hitThreshold: ambiguous — treat as miss. */
  grayZoneHigh: number;
  maxRagChunks: number;
  mmrLambda: number;
  lightModel: string | null;
  mediumModel: string | null;
  heavyModel: string | null;
}

export const DEFAULT_SEMANTIC_CONFIG: SemanticLayerConfig = {
  enabled: false,
  cacheEnabled: true,
  routerEnabled: true,
  compressorEnabled: true,
  maxCacheEntries: 256,
  cacheTtlMs: 30 * 60 * 1000,
  hitThreshold: 0.92,
  grayZoneLow: 0.85,
  grayZoneHigh: 0.92,
  maxRagChunks: 6,
  mmrLambda: 0.7,
  lightModel: null,
  mediumModel: null,
  heavyModel: null,
};

/** Merge persisted settings with static defaults. */
export function resolveSemanticConfig(): SemanticLayerConfig {
  const s = useSettingsStore.getState();
  return {
    ...DEFAULT_SEMANTIC_CONFIG,
    enabled: s.semanticLayerEnabled,
    cacheEnabled: s.semanticCacheEnabled,
    routerEnabled: s.semanticRouterEnabled,
    compressorEnabled: s.semanticCompressorEnabled,
    lightModel: s.semanticLightModel?.trim() || null,
    mediumModel: s.semanticMediumModel?.trim() || null,
    heavyModel: s.semanticHeavyModel?.trim() || null,
  };
}

/** Raise the hit bar slightly as the cache fills to reduce false positives. */
export function effectiveHitThreshold(
  config: SemanticLayerConfig,
  cacheSize: number,
): number {
  const fill = cacheSize / Math.max(1, config.maxCacheEntries);
  return Math.min(0.98, config.hitThreshold + fill * 0.03);
}
