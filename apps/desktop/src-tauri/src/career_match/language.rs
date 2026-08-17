//! The pluggable language layer.
//!
//! Résumé synthesis has exactly two stages that need natural language: JD
//! analysis and bullet rewriting. Everything else in `career_match` is
//! deterministic. This module makes those two stages pluggable across three
//! providers:
//!
//! - [`LanguageProvider::Deterministic`] — no model. JD analysis falls back to
//!   `jd::extract_heuristic`; bullets stay canonical. Always available.
//! - [`LanguageProvider::Agent`] — the connected MCP client is the model. Rust
//!   hands out a work order and verifies whatever comes back.
//! - [`LanguageProvider::Ollama`] — Rust calls a local model directly, so a
//!   full synthesis costs zero external tokens.
//!
//! ## The invariant that makes this safe
//!
//! [`verify_rewrite`] is the single gate every candidate bullet passes,
//! whatever produced it. A local model, a frontier model over MCP, and a
//! hand-typed string are all held to the same contract: preserve every
//! ground-truth metric, stay inside the line budget, and never touch a locked
//! bullet. A candidate that fails is **replaced by the canonical text** and the
//! reason is reported — it is never silently accepted, and never repaired by
//! inventing content.
//!
//! This is why adding a weaker local model cannot lower factual quality: the
//! floor is the canonical bullet, which is the user's own verified text.

use serde::Serialize;
use serde_json::{json, Value};

use crate::career_db::{Bullet, ExperienceBlock};

use super::jd::{self, JdProfile};
use super::metrics::{dropped_metrics, introduced_figures, metrics_values_preserved};

/// Why a candidate rewrite was rejected in favour of the canonical bullet.
/// Values match the TypeScript `BulletFallbackReason` union so both pipelines
/// report the same vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackReason {
    LlmFailed,
    MetricsLost,
    OverBudget,
    Locked,
    InvalidProvenance,
    /// The candidate introduced a figure that is in neither the canonical
    /// bullet nor its declared metrics.
    FabricatedMetric,
    /// The candidate was empty or identical to the canonical text.
    NoChange,
}

impl FallbackReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LlmFailed => "llm-failed",
            Self::MetricsLost => "metrics-lost",
            Self::OverBudget => "over-budget",
            Self::Locked => "locked",
            Self::InvalidProvenance => "invalid-provenance",
            Self::FabricatedMetric => "fabricated-metric",
            Self::NoChange => "no-change",
        }
    }
}

/// One bullet after the rewrite stage, with an honest account of its origin.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewrittenBullet {
    pub id: String,
    /// The user's verified text — always present, always the fallback.
    pub canonical: String,
    /// The text that will actually be rendered.
    pub text: String,
    /// True only when a model produced `text` **and** it passed verification.
    /// Never hardcoded.
    pub ai_generated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<&'static str>,
    /// Ground-truth metrics the candidate dropped. Empty when accepted.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dropped_metrics: Vec<String>,
}

impl RewrittenBullet {
    fn canonical_fallback(bullet: &Bullet, reason: FallbackReason, dropped: Vec<String>) -> Self {
        Self {
            id: bullet.id.clone(),
            canonical: bullet.canonical.clone(),
            text: bullet.canonical.clone(),
            ai_generated: false,
            fallback_reason: Some(reason.as_str()),
            dropped_metrics: dropped,
        }
    }
}

/// Character budget for a single rewritten bullet. Matches
/// `TYPST_ATS_SINGLE_TEMPLATE.budget.perBullet`; the two-column variant uses
/// 120. This is a **character** count, not a line count — see
/// `rewrite.ts:360`.
pub const DEFAULT_PER_BULLET_CHARS: usize = 140;

/// The one gate every candidate rewrite passes, regardless of origin.
///
/// Port of `enforceBulletInvariants` (`rewrite.ts:321`), same order: locked →
/// empty → metrics → budget. Returns the accepted text, or the reason it was
/// rejected. Rejection is not an error — the caller substitutes the canonical
/// bullet.
///
/// Two deliberate divergences, both toward honesty:
///
/// 1. A candidate identical to the canonical text yields `NoChange` rather
///    than being counted as a successful rewrite, so `aiRewrittenCount` cannot
///    be inflated by a model that simply echoes its input.
/// 2. TypeScript truncates an over-budget bullet **after** verifying metrics
///    (`text.slice(0, perBullet - 1)`), which can slice off a trailing figure
///    that had just passed — silently emitting a bullet whose metric was
///    dropped. Here the truncated text is re-verified, and falls back to
///    canonical if truncation cost a metric. Pinned by
///    `truncation_that_would_cut_a_metric_falls_back`.
///
/// A third addition has no TypeScript counterpart at all: a candidate may not
/// introduce a figure that is in neither the canonical bullet nor its declared
/// metrics. `metricsValuesPreserved` only checks that *known* figures survived,
/// so a bullet with no recorded metrics passes vacuously and a model can attach
/// any number it likes. Pinned by
/// `a_figure_invented_from_nothing_is_rejected`.
///
/// The `latex-rejected` branch has no counterpart: the résumé engine is Typst
/// only, and `typst_emit` makes injection impossible by construction, so there
/// is no forbidden-command class to screen for.
pub fn verify_rewrite(
    bullet: &Bullet,
    candidate: &str,
    per_bullet_chars: usize,
) -> Result<String, (FallbackReason, Vec<String>)> {
    if bullet.locked {
        return Err((FallbackReason::Locked, Vec::new()));
    }
    let text = candidate.trim();
    if text.is_empty() {
        return Err((FallbackReason::LlmFailed, Vec::new()));
    }
    if text == bullet.canonical.trim() {
        return Err((FallbackReason::NoChange, Vec::new()));
    }
    if !metrics_values_preserved(&bullet.metrics, text) {
        return Err((
            FallbackReason::MetricsLost,
            dropped_metrics(&bullet.metrics, text),
        ));
    }
    // Preserving the known figures is not enough: a bullet with no recorded
    // metrics would otherwise let a model attach any number it invented.
    let invented = introduced_figures(&bullet.canonical, &bullet.metrics, text);
    if !invented.is_empty() {
        return Err((FallbackReason::FabricatedMetric, invented));
    }

    if per_bullet_chars == 0 || text.chars().count() <= per_bullet_chars {
        return Ok(text.to_string());
    }
    // Over budget. If the user's own bullet fits, prefer it outright.
    if bullet.canonical.chars().count() <= per_bullet_chars {
        return Err((FallbackReason::OverBudget, Vec::new()));
    }
    // Otherwise truncate on a word boundary, then re-verify.
    let truncated = truncate_on_word_boundary(text, per_bullet_chars);
    if !metrics_values_preserved(&bullet.metrics, &truncated) {
        return Err((
            FallbackReason::OverBudget,
            dropped_metrics(&bullet.metrics, &truncated),
        ));
    }
    Ok(truncated)
}

/// `text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…"` — drop the partial
/// trailing word, then append an ellipsis.
fn truncate_on_word_boundary(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let cut = max.saturating_sub(1).min(chars.len());
    let head: String = chars[..cut].iter().collect();
    let trimmed = match head.rfind(char::is_whitespace) {
        // Only drop the tail when it is a partial word, i.e. the cut landed
        // mid-token rather than exactly on a boundary.
        Some(i) if !head.ends_with(char::is_whitespace) => head[..i].trim_end().to_string(),
        _ => head.trim_end().to_string(),
    };
    format!("{trimmed}…")
}

/// Apply `verify_rewrite` to a candidate, producing a `RewrittenBullet` either
/// way. `from_model` distinguishes a real model attempt from a passthrough, so
/// `aiGenerated` never overstates what happened.
pub fn accept_or_fall_back(
    bullet: &Bullet,
    candidate: Option<&str>,
    per_bullet_chars: usize,
) -> RewrittenBullet {
    let Some(candidate) = candidate else {
        return RewrittenBullet::canonical_fallback(bullet, FallbackReason::LlmFailed, Vec::new());
    };
    match verify_rewrite(bullet, candidate, per_bullet_chars) {
        Ok(text) => RewrittenBullet {
            id: bullet.id.clone(),
            canonical: bullet.canonical.clone(),
            text,
            ai_generated: true,
            fallback_reason: None,
            dropped_metrics: Vec::new(),
        },
        Err((reason, dropped)) => RewrittenBullet::canonical_fallback(bullet, reason, dropped),
    }
}

// --- Provider ------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum LanguageProvider {
    /// No model. Deterministic extraction, canonical bullets.
    Deterministic,
    /// The MCP client supplies the language; Rust issues work orders and
    /// verifies the results.
    Agent,
    /// Rust drives a local Ollama model.
    Ollama {
        base_url: String,
        model: String,
        num_ctx: Option<u32>,
        temperature: Option<f32>,
    },
}

impl LanguageProvider {
    /// Parse the `language` argument of an MCP tool call.
    ///
    /// Shape: `{"mode":"ollama","model":"qwen3.5:27b","baseUrl":"…"}`.
    /// Unknown or absent → `Deterministic`, so a typo degrades to the honest
    /// path rather than silently doing something else.
    pub fn from_args(v: Option<&Value>) -> Self {
        let Some(obj) = v.and_then(Value::as_object) else {
            return Self::Deterministic;
        };
        match obj.get("mode").and_then(Value::as_str).unwrap_or("") {
            "agent" => Self::Agent,
            "ollama" => Self::Ollama {
                base_url: obj
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("http://localhost:11434")
                    .to_string(),
                model: obj
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                num_ctx: obj.get("numCtx").and_then(Value::as_u64).map(|n| n as u32),
                temperature: obj
                    .get("temperature")
                    .and_then(Value::as_f64)
                    .map(|t| t as f32),
            },
            _ => Self::Deterministic,
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Deterministic => "deterministic".into(),
            Self::Agent => "agent".into(),
            Self::Ollama { model, .. } => format!("ollama:{model}"),
        }
    }

    /// True when this provider produces language locally at zero external cost.
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Deterministic | Self::Ollama { .. })
    }
}

/// Strip markdown fences and return the outermost JSON object in `raw`.
///
/// Local models frequently wrap JSON in ```json fences or add a sentence of
/// preamble even under `format: "json"`; failing on that would make the local
/// path look worse than it is.
pub fn extract_json_object(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Some(v);
    }
    // Find the first balanced {...} span, ignoring braces inside strings.
    let bytes: Vec<char> = trimmed.chars().collect();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, c) in bytes.iter().copied().enumerate() {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    if let Some(s) = start {
                        let span: String = bytes[s..=i].iter().collect();
                        if let Ok(v) = serde_json::from_str::<Value>(&span) {
                            return Some(v);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// JD analysis is pure extraction: any creativity is a chance to invent a
/// requirement the posting never stated.
const JD_TEMPERATURE: f32 = 0.1;

/// Rewriting needs room to actually rephrase. At 0.1 both local models tested
/// simply echoed the canonical bullet back, which `verify_rewrite` correctly
/// reports as `no-change` — safe, but no tailoring. The output is verified
/// afterwards regardless, so a higher temperature costs nothing in factual
/// terms.
const REWRITE_TEMPERATURE: f32 = 0.45;

const JD_SYSTEM: &str = r#"You analyze job descriptions for resume targeting.
Return ONLY a JSON object with this exact shape:
{
  "roleTitle": string,
  "seniority": "ic"|"senior"|"lead"|"manager"|"director",
  "mustHaveSkills": string[],
  "niceToHaveSkills": string[],
  "domains": string[],
  "atsKeywords": string[],
  "toneSignals": string[],
  "responsibilitiesText": string,
  "qualificationsText": string
}
Rules:
- mustHaveSkills: hard requirements (tools, languages, years, certifications).
- niceToHaveSkills: preferred / bonus skills.
- domains: industry or problem domains (e.g. genomics, fintech).
- atsKeywords: short ATS-friendly keyword phrases from the JD (skills + role nouns).
- toneSignals: adjectives describing desired tone (e.g. "collaborative", "metrics-driven").
- responsibilitiesText: 2-6 sentence extract of core responsibilities (plain text).
- qualificationsText: 2-6 sentence extract of qualifications / requirements (plain text).
- Infer seniority from titles (Staff/Principal -> lead, Senior -> senior, Manager/Director -> manager/director, else ic).
- Output ONLY JSON - no markdown fences, no commentary."#;

/// System prompt for bullet rewriting. The anti-hallucination rules are stated
/// for the model's benefit, but they are *enforced* by `verify_rewrite`, not
/// trusted to the model.
const REWRITE_SYSTEM: &str = r#"You tailor resume bullets to a job description.
Return ONLY a JSON object: {"bullets":[{"id": string, "text": string}]}
Rules:
- Preserve EVERY number, percentage, multiplier and currency figure exactly as given. Never round, inflate, or invent one.
- Never introduce a technology, employer, title, or achievement not present in the source bullet.
- Echo the job description's vocabulary only where the source bullet already supports it.
- Keep each bullet to one or two lines (about 95 characters per line).
- Start with a strong past-tense action verb.
- Return one entry per input bullet, keeping its id.
- Actually rephrase: lead with a different, stronger verb and restructure the sentence around the target role. Returning the input unchanged is a failure.
- Output ONLY JSON - no markdown fences, no commentary."#;

/// Build the user prompt for a block rewrite. Shared by the Ollama path and
/// the agent work order so both models see the same instructions.
pub fn rewrite_prompt(block: &ExperienceBlock, profile: &JdProfile, bullets: &[&Bullet]) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "Target role: {} ({})\n",
        profile.role_title, profile.seniority
    ));
    if !profile.must_have_skills.is_empty() {
        s.push_str(&format!(
            "Required skills: {}\n",
            profile.must_have_skills.join(", ")
        ));
    }
    if !profile.ats_keywords.is_empty() {
        s.push_str(&format!("ATS keywords: {}\n", profile.ats_keywords.join(", ")));
    }
    s.push_str(&format!("\nRole: {} at {}\n\nBullets:\n", block.title, block.org));
    for b in bullets {
        s.push_str(&format!("- id={}: {}\n", b.id, b.canonical));
        if !b.metrics.is_empty() {
            let vals: Vec<&str> = b.metrics.iter().map(|m| m.value.as_str()).collect();
            s.push_str(&format!(
                "  (these figures MUST appear unchanged: {})\n",
                vals.join(", ")
            ));
        }
    }
    s
}

impl LanguageProvider {
    /// Stage 1 — JD analysis.
    ///
    /// Returns the profile plus notices describing any degradation, so the
    /// caller can report *how* the profile was derived rather than implying an
    /// LLM read the JD when it did not.
    pub async fn analyze_jd(&self, jd_text: &str) -> (JdProfile, Vec<String>) {
        let heuristic = jd::extract_heuristic(jd_text);
        match self {
            Self::Deterministic => (
                heuristic,
                vec!["JD parsed by the deterministic extractor (no language model configured); skills are limited to a known lexicon.".into()],
            ),
            Self::Agent => (
                heuristic,
                vec!["JD parsed by the deterministic extractor; call `resume_submit_jd_profile` to replace it with a model-derived profile.".into()],
            ),
            Self::Ollama { .. } => {
                let prompt = format!(
                    "Job description:\n{}",
                    jd::truncate_chars(jd_text, 12_000)
                );
                match self.complete_json(JD_SYSTEM, &prompt, JD_TEMPERATURE).await {
                    Ok(v) => {
                        let profile = jd::normalize(&v, jd_text);
                        if profile.is_extraction_empty()
                            && jd_text.len() > jd::JD_NONTRIVIAL_MIN_CHARS
                        {
                            // A substantive JD that yielded nothing means the
                            // model failed; the heuristic is strictly better
                            // than an empty profile.
                            (
                                heuristic,
                                vec![format!(
                                    "{} returned no skills for a substantive JD; fell back to the deterministic extractor.",
                                    self.label()
                                )],
                            )
                        } else {
                            (profile, Vec::new())
                        }
                    }
                    Err(e) => (
                        heuristic,
                        vec![format!(
                            "{} failed ({e}); fell back to the deterministic extractor.",
                            self.label()
                        )],
                    ),
                }
            }
        }
    }

    /// Stage 5 — rewrite one block's bullets.
    ///
    /// Every returned bullet has been through `verify_rewrite`. For
    /// `Deterministic` and `Agent` the canonical text is returned unchanged and
    /// honestly marked as not AI-generated.
    pub async fn rewrite_block(
        &self,
        block: &ExperienceBlock,
        profile: &JdProfile,
        per_bullet_chars: usize,
    ) -> Vec<RewrittenBullet> {
        let bullets: Vec<&Bullet> = block.bullets.iter().collect();
        match self {
            Self::Deterministic | Self::Agent => bullets
                .iter()
                .map(|b| RewrittenBullet {
                    id: b.id.clone(),
                    canonical: b.canonical.clone(),
                    text: b.canonical.clone(),
                    ai_generated: false,
                    fallback_reason: None,
                    dropped_metrics: Vec::new(),
                })
                .collect(),
            Self::Ollama { .. } => {
                let prompt = rewrite_prompt(block, profile, &bullets);
                let by_id: std::collections::HashMap<String, String> =
                    match self.complete_json(REWRITE_SYSTEM, &prompt, REWRITE_TEMPERATURE).await {
                        Ok(v) => v
                            .get("bullets")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|item| {
                                        let id = item.get("id").and_then(Value::as_str)?;
                                        let text = item.get("text").and_then(Value::as_str)?;
                                        Some((id.to_string(), text.to_string()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        Err(_) => std::collections::HashMap::new(),
                    };
                bullets
                    .iter()
                    .map(|b| {
                        accept_or_fall_back(
                            b,
                            by_id.get(&b.id).map(String::as_str),
                            per_bullet_chars,
                        )
                    })
                    .collect()
            }
        }
    }

    /// Embed a query locally so scoring can use its semantic component.
    ///
    /// Returns `None` for every provider except Ollama, and for Ollama when no
    /// embedding model is installed — callers then set
    /// `semantic_matching_disabled` and the embedding weight is renormalized
    /// away rather than silently counting as zero similarity.
    pub async fn embed_query(&self, text: &str) -> Option<Vec<f32>> {
        let Self::Ollama { base_url, .. } = self else {
            return None;
        };
        let model = crate::native_agent::ollama::first_embedding_model(base_url)
            .await
            .ok()??;
        let client =
            crate::native_agent::ollama::OllamaClient::new(base_url, &model, None, None);
        client
            .embed(&[jd::truncate_chars(text, 8_000)])
            .await
            .ok()?
            .into_iter()
            .next()
            .filter(|v| !v.is_empty())
    }

    /// One-shot JSON completion against the configured local model.
    async fn complete_json(
        &self,
        system: &str,
        prompt: &str,
        default_temperature: f32,
    ) -> Result<Value, String> {
        let Self::Ollama {
            base_url,
            model,
            num_ctx,
            temperature,
        } = self
        else {
            return Err("complete_json requires the Ollama provider".into());
        };

        let model = if model.trim().is_empty() {
            crate::native_agent::ollama::first_installed_model(base_url)
                .await?
                .ok_or_else(|| {
                    "no chat-capable model is installed in Ollama; run `ollama pull qwen3.5:27b`"
                        .to_string()
                })?
        } else {
            model.clone()
        };

        let client = crate::native_agent::ollama::OllamaClient::new(
            base_url,
            &model,
            *num_ctx,
            Some(temperature.unwrap_or(default_temperature)),
        )
        .with_json_format()
        // Both prompts here ask for a fixed JSON schema, and the answer is
        // checked by `verify_rewrite` afterwards rather than trusted — so a
        // reasoning trace buys nothing and costs a great deal of latency.
        // Thinking-capable models default to *on* when the field is omitted.
        .without_think();

        let messages = json!([
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]);
        let turn = client.chat(&messages, &json!([]), |_, _| {}).await?;
        extract_json_object(&turn.content)
            .ok_or_else(|| format!("model returned no parseable JSON object: {}", {
                let c = turn.content.trim();
                jd::truncate_chars(c, 200)
            }))
    }
}
