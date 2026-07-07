import {
  type ModelTier,
  type SemanticLayerConfig,
} from "@/lib/semantic-layer/config";

export interface RouterDecision {
  tier: ModelTier;
  complexity: number;
  modelOverride: string | null;
}

const HEAVY_RE =
  /\b(analyze|compare|implement|refactor|architect|design|prove|evaluate|synthesize|debug|optimize|rewrite)\b/i;
const LIGHT_RE =
  /\b(grammar|typo|summarize|short|one line|json only|fix lint|continue after)\b/i;

/**
 * Score query complexity on [0, 1]. Higher → heavier model tier.
 * Exported for unit tests.
 */
export function scoreComplexity(
  prompt: string,
  system?: string,
  format?: "json",
): number {
  const text = `${system ?? ""}\n${prompt}`;
  let score = 0.28;

  const len = text.length;
  if (len > 2500) score += 0.28;
  else if (len > 1000) score += 0.18;
  else if (len > 400) score += 0.08;
  else if (len < 80) score -= 0.12;

  if (format === "json") score += 0.08;
  if (HEAVY_RE.test(text)) score += 0.22;
  if (LIGHT_RE.test(text)) score -= 0.18;

  const questions = (text.match(/\?/g) ?? []).length;
  if (questions > 2) score += 0.1;
  else if (questions === 1) score += 0.04;

  if (/```/.test(text)) score += 0.12;
  if (/\n- /.test(text) && (text.match(/\n- /g) ?? []).length >= 3)
    score += 0.06;

  return Math.max(0, Math.min(1, score));
}

/** Map complexity score to a model tier. */
export function tierForComplexity(complexity: number): ModelTier {
  if (complexity < 0.38) return "light";
  if (complexity < 0.62) return "medium";
  return "heavy";
}

function modelForTier(
  tier: ModelTier,
  config: SemanticLayerConfig,
  defaultModel: string | null,
): string | null {
  const mapped =
    tier === "light"
      ? config.lightModel
      : tier === "medium"
        ? config.mediumModel
        : config.heavyModel;
  return mapped ?? defaultModel;
}

/** Pick a model tier and optional override for the resolved default model. */
export function routeQuery(
  prompt: string,
  config: SemanticLayerConfig,
  defaultModel: string | null,
  options?: { system?: string; format?: "json" },
): RouterDecision {
  const complexity = scoreComplexity(prompt, options?.system, options?.format);
  const tier = tierForComplexity(complexity);
  const resolved = modelForTier(tier, config, defaultModel);
  const modelOverride =
    resolved && defaultModel && resolved !== defaultModel ? resolved : null;
  return {
    tier,
    complexity,
    modelOverride,
  };
}
