use super::SemanticLayerConfig;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelTier {
    Light,
    Medium,
    Heavy,
}

pub struct RouterDecision {
    pub tier: ModelTier,
    pub complexity: f32,
    pub model_override: Option<String>,
}

const HEAVY_TERMS: &[&str] = &[
    "analyze", "compare", "implement", "refactor", "architect", "design", "prove",
    "evaluate", "synthesize", "debug", "optimize", "rewrite",
];
const LIGHT_TERMS: &[&str] = &[
    "grammar", "typo", "summarize", "short", "one line", "json only", "fix lint",
    "continue after",
];

pub fn score_complexity(prompt: &str, system: Option<&str>) -> f32 {
    let sys = system.unwrap_or("");
    let text = format!("{sys}\n{prompt}");
    let mut score = 0.28f32;

    let len = text.len();
    if len > 2500 {
        score += 0.28;
    } else if len > 1000 {
        score += 0.18;
    } else if len > 400 {
        score += 0.08;
    } else if len < 80 {
        score -= 0.12;
    }

    if contains_any_term(&text, HEAVY_TERMS) {
        score += 0.22;
    }
    if contains_any_term(&text, LIGHT_TERMS) {
        score -= 0.18;
    }

    let questions = text.matches('?').count();
    if questions > 2 {
        score += 0.1;
    } else if questions == 1 {
        score += 0.04;
    }

    if text.contains("```") {
        score += 0.12;
    }
    if text.contains("\n- ") && text.matches("\n- ").count() >= 3 {
        score += 0.06;
    }

    score.clamp(0.0, 1.0)
}

pub fn tier_for_complexity(complexity: f32) -> ModelTier {
    if complexity < 0.38 {
        ModelTier::Light
    } else if complexity < 0.62 {
        ModelTier::Medium
    } else {
        ModelTier::Heavy
    }
}

fn model_for_tier(tier: ModelTier, config: &SemanticLayerConfig, default_model: &str) -> String {
    match tier {
        ModelTier::Light => config
            .light_model
            .clone()
            .unwrap_or_else(|| default_model.to_string()),
        ModelTier::Medium => config
            .medium_model
            .clone()
            .unwrap_or_else(|| default_model.to_string()),
        ModelTier::Heavy => config
            .heavy_model
            .clone()
            .unwrap_or_else(|| default_model.to_string()),
    }
}

pub fn route_query(
    prompt: &str,
    config: &SemanticLayerConfig,
    default_model: &str,
    system: Option<&str>,
) -> RouterDecision {
    let complexity = score_complexity(prompt, system);
    let tier = tier_for_complexity(complexity);
    let resolved = model_for_tier(tier, config, default_model);
    let model_override = if resolved != default_model {
        Some(resolved)
    } else {
        None
    };
    RouterDecision {
        tier,
        complexity,
        model_override,
    }
}

fn contains_any_term(text: &str, terms: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    terms.iter().any(|term| lower.contains(term))
}
