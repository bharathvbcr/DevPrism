//! Hybrid block scoring.
//!
//! Faithful Rust port of `src/lib/resume-synthesis/scoring.ts`:
//!
//! ```text
//! score = 0.40*embedding + 0.30*skills + 0.15*persona
//!       + 0.10*recency   + 0.05*seniority
//! ```
//!
//! When embeddings are unavailable the embedding weight drops to 0 and the
//! remaining weights are renormalised, so a headless MCP run without an
//! embedding provider produces a well-formed score rather than one that is
//! silently 40% smaller.
//!
//! The MCP scorer this replaces gave every block a 0.5 baseline, added 0.25 per
//! JD-mentioned skill, clamped to 1.0 (so any block with two hits saturated and
//! ties broke arbitrarily), and tried to score bullets by asking whether the JD
//! text contained the entire bullet, which is never true.

use crate::career_db::{DateRange, ExperienceBlock, SkillTag};
use std::collections::HashMap;

use super::text::{canonical_skill_key, norm_skill, skills_match};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoreWeights {
    pub embedding: f64,
    pub skills: f64,
    pub persona: f64,
    pub recency: f64,
    pub seniority: f64,
}

pub const DEFAULT_WEIGHTS: ScoreWeights = ScoreWeights {
    embedding: 0.4,
    skills: 0.3,
    persona: 0.15,
    recency: 0.1,
    seniority: 0.05,
};

/// Renormalise so weights sum to 1. Zeroes stay zero.
pub fn renormalize_weights(w: ScoreWeights) -> ScoreWeights {
    let sum = w.embedding + w.skills + w.persona + w.recency + w.seniority;
    if sum <= 0.0 {
        return ScoreWeights {
            embedding: 0.0,
            skills: 1.0,
            persona: 0.0,
            recency: 0.0,
            seniority: 0.0,
        };
    }
    ScoreWeights {
        embedding: w.embedding / sum,
        skills: w.skills / sum,
        persona: w.persona / sum,
        recency: w.recency / sum,
        seniority: w.seniority / sum,
    }
}

/// Weights for a run where semantic matching may be unavailable.
pub fn weights_for(semantic_available: bool) -> ScoreWeights {
    if semantic_available {
        DEFAULT_WEIGHTS
    } else {
        renormalize_weights(ScoreWeights { embedding: 0.0, ..DEFAULT_WEIGHTS })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreComponents {
    pub embedding: f64,
    pub skills: f64,
    pub persona: f64,
    pub recency: f64,
    pub seniority: f64,
}

fn clamp01(n: f64) -> f64 {
    if !n.is_finite() {
        return 0.0;
    }
    n.clamp(0.0, 1.0)
}

/// Exact + token/alias skill overlap; must-haves count double.
pub fn skill_overlap(
    block_skills: &[SkillTag],
    must_have: &[String],
    nice_to_have: &[String],
    persona_weights: Option<&HashMap<String, f64>>,
) -> f64 {
    let names: Vec<&str> = block_skills
        .iter()
        .map(|s| s.name.as_str())
        .filter(|n| !n.trim().is_empty())
        .collect();
    if names.is_empty() && must_have.is_empty() && nice_to_have.is_empty() {
        return 0.0;
    }

    let match_one = |target: &str| -> bool {
        if target.trim().is_empty() {
            return false;
        }
        names.iter().any(|n| skills_match(n, target))
    };

    let boost_for = |s: &str| -> f64 {
        let Some(pw) = persona_weights else { return 1.0 };
        pw.get(s)
            .or_else(|| pw.get(&norm_skill(s)))
            .or_else(|| pw.get(&canonical_skill_key(s)))
            .copied()
            // A NaN weight propagated through max(0.5) and collapsed a perfect
            // skill match to the worst possible score.
            .filter(|w| w.is_finite())
            .unwrap_or(1.0)
    };

    let mut hits = 0.0f64;
    let mut weight = 0.0f64;
    for s in must_have {
        weight += 2.0;
        if match_one(s) {
            hits += 2.0 * boost_for(s).max(0.5);
        }
    }
    for s in nice_to_have {
        weight += 1.0;
        if match_one(s) {
            hits += boost_for(s).max(0.5);
        }
    }

    if weight == 0.0 {
        let Some(pw) = persona_weights else { return 0.0 };
        let mut p_hits = 0.0f64;
        let mut p_w = 0.0f64;
        // Sorted: HashMap iteration order varies per process, and float addition
        // is not associative, so an unsorted sum made scores irreproducible.
        let mut keys: Vec<&String> = pw.keys().collect();
        keys.sort();
        for skill in keys {
            let w = pw.get(skill).copied().unwrap_or(0.0);
            if !w.is_finite() {
                continue;
            }
            p_w += w.abs();
            if match_one(skill) {
                p_hits += w.abs();
            }
        }
        return if p_w > 0.0 { clamp01(p_hits / p_w) } else { 0.0 };
    }
    clamp01(hits / weight)
}

pub fn persona_affinity(block_personas: &[String], persona_id: &str) -> f64 {
    if persona_id.is_empty() {
        return 0.5;
    }
    if block_personas.is_empty() {
        return 0.35;
    }
    if block_personas.iter().any(|p| p == persona_id) {
        return 1.0;
    }
    0.15
}

/// Parse a leading `YYYY` with optional `-MM`, defaulting the month to 6.
fn parse_year_month(iso: &str) -> Option<(i32, u32)> {
    let t = iso.trim();
    let year_str: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if year_str.len() != 4 {
        return None;
    }
    let year: i32 = year_str.parse().ok()?;
    if year < 1970 {
        return None;
    }
    let rest = &t[year_str.len()..];
    let month = rest
        .strip_prefix('-')
        .map(|m| {
            let digits: String = m.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().unwrap_or(6)
        })
        .unwrap_or(6);
    Some((year, month.clamp(1, 12)))
}

/// Exponential decay from the end date (or start when open-ended).
/// Half-life ~4 years.
pub fn recency_decay(range: &DateRange, now_year: i32, now_month: u32) -> f64 {
    let end = range
        .end
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| range.start.trim());
    let Some((year, month)) = parse_year_month(end) else {
        return 0.5;
    };
    // i64 and saturating arithmetic: `now_year` reaches this from a caller and
    // an i32 multiply overflowed (and panicked in debug) for large values.
    let months = (now_year as i64 - year as i64)
        .saturating_mul(12)
        .saturating_add(now_month as i64 - month as i64);
    let years = (months as f64 / 12.0).max(0.0);
    clamp01(0.5f64.powf(years / 4.0))
}

fn seniority_rank(level: &str) -> i32 {
    match level.trim().to_lowercase().as_str() {
        "ic" => 0,
        "senior" => 1,
        "lead" => 2,
        "manager" => 3,
        "director" => 4,
        // Unknown levels default to 1, matching the TS `?? 1`.
        _ => 1,
    }
}

pub fn seniority_fit(block_level: &str, jd_seniority: &str) -> f64 {
    let dist = (seniority_rank(block_level) - seniority_rank(jd_seniority)).abs();
    match dist {
        0 => 1.0,
        1 => 0.7,
        2 => 0.4,
        _ => 0.15,
    }
}

pub fn combine_score(c: &ScoreComponents, w: &ScoreWeights) -> f64 {
    clamp01(
        w.embedding * c.embedding
            + w.skills * c.skills
            + w.persona * c.persona
            + w.recency * c.recency
            + w.seniority * c.seniority,
    )
}

#[derive(Debug, Clone)]
pub struct ScoredBlock {
    pub block: ExperienceBlock,
    pub components: ScoreComponents,
    pub score: f64,
}

/// Inputs a caller must supply to score a block.
pub struct ScoringContext<'a> {
    pub must_have: &'a [String],
    pub nice_to_have: &'a [String],
    pub jd_seniority: &'a str,
    pub persona_id: &'a str,
    pub persona_weights: Option<&'a HashMap<String, f64>>,
    pub weights: ScoreWeights,
    pub now_year: i32,
    pub now_month: u32,
}

pub fn hybrid_score(
    block: &ExperienceBlock,
    ctx: &ScoringContext<'_>,
    embedding_score: f64,
) -> ScoredBlock {
    let components = ScoreComponents {
        embedding: clamp01(embedding_score),
        skills: skill_overlap(&block.skills, ctx.must_have, ctx.nice_to_have, ctx.persona_weights),
        persona: persona_affinity(&block.personas, ctx.persona_id),
        recency: recency_decay(&block.date_range, ctx.now_year, ctx.now_month),
        seniority: seniority_fit(&block.seniority_level, ctx.jd_seniority),
    };
    let score = combine_score(&components, &ctx.weights);
    ScoredBlock { block: block.clone(), components, score }
}

/// Score every block, sorted by score desc then block id asc (a total order, so
/// results are reproducible run to run).
pub fn score_blocks(
    blocks: &[ExperienceBlock],
    ctx: &ScoringContext<'_>,
    embedding_by_block_id: &HashMap<String, f64>,
) -> Vec<ScoredBlock> {
    let mut out: Vec<ScoredBlock> = blocks
        .iter()
        .map(|b| {
            hybrid_score(b, ctx, embedding_by_block_id.get(&b.id).copied().unwrap_or(0.0))
        })
        .collect();
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.block.id.cmp(&b.block.id))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::career_db::{Bullet, DateRange, ExperienceBlock, SkillTag};

    fn skill(name: &str) -> SkillTag {
        SkillTag { name: name.to_string(), level: 3, years: None }
    }

    fn block(id: &str, skills: &[&str]) -> ExperienceBlock {
        ExperienceBlock {
            id: id.to_string(),
            kind: "experience".into(),
            title: "Engineer".into(),
            org: format!("Org {id}"),
            date_range: DateRange { start: "2023-01".into(), end: None },
            personas: vec![],
            domains: vec![],
            skills: skills.iter().map(|s| skill(s)).collect(),
            seniority_level: "senior".into(),
            location: None,
            url: None,
            url_label: None,
            extra: None,
            bullets: vec![],
            facts: vec![],
            notes: None,
            embedding_text: None,
            updated_at: "0".into(),
        }
    }

    #[test]
    fn weights_renormalize_to_one_without_embeddings() {
        let w = weights_for(false);
        let sum = w.embedding + w.skills + w.persona + w.recency + w.seniority;
        assert!((sum - 1.0).abs() < 1e-9, "sum was {sum}");
        assert_eq!(w.embedding, 0.0);
        let w2 = weights_for(true);
        assert_eq!(w2.embedding, 0.4);
    }

    #[test]
    fn renormalize_handles_all_zero_weights() {
        let w = renormalize_weights(ScoreWeights {
            embedding: 0.0,
            skills: 0.0,
            persona: 0.0,
            recency: 0.0,
            seniority: 0.0,
        });
        assert_eq!(w.skills, 1.0);
    }

    #[test]
    fn must_haves_count_double() {
        let s = vec![skill("Python")];
        let only_must = skill_overlap(&s, &["python".into()], &[], None);
        let only_nice = skill_overlap(&s, &[], &["python".into()], None);
        assert_eq!(only_must, 1.0);
        assert_eq!(only_nice, 1.0);
        // Half the weight satisfied when only the nice-to-have matches.
        let mixed = skill_overlap(&s, &["rust".into()], &["python".into()], None);
        assert!((mixed - (1.0 / 3.0)).abs() < 1e-9, "got {mixed}");
    }

    #[test]
    fn skill_overlap_uses_word_boundary_matching() {
        let s = vec![skill("MongoDB")];
        // "go" must not be satisfied by "mongodb".
        assert_eq!(skill_overlap(&s, &["go".into()], &[], None), 0.0);
    }

    #[test]
    fn skill_overlap_is_bounded() {
        let s = vec![skill("Python"), skill("Rust"), skill("Go")];
        let v = skill_overlap(&s, &["python".into(), "rust".into(), "go".into()], &[], None);
        assert!((0.0..=1.0).contains(&v));
        assert_eq!(v, 1.0);
        assert_eq!(skill_overlap(&[], &[], &[], None), 0.0);
    }

    #[test]
    fn persona_affinity_matches_the_canonical_ladder() {
        assert_eq!(persona_affinity(&[], ""), 0.5);
        assert_eq!(persona_affinity(&[], "ai"), 0.35);
        assert_eq!(persona_affinity(&["ai".into()], "ai"), 1.0);
        assert_eq!(persona_affinity(&["mgmt".into()], "ai"), 0.15);
    }

    #[test]
    fn recency_halves_every_four_years() {
        let r = DateRange { start: "2020-06".into(), end: Some("2020-06".into()) };
        let now = recency_decay(&r, 2020, 6);
        assert!((now - 1.0).abs() < 1e-9, "got {now}");
        let four = recency_decay(&r, 2024, 6);
        assert!((four - 0.5).abs() < 1e-9, "got {four}");
        let eight = recency_decay(&r, 2028, 6);
        assert!((eight - 0.25).abs() < 1e-9, "got {eight}");
    }

    #[test]
    fn open_ended_range_uses_start_and_unparseable_dates_default() {
        let open = DateRange { start: "2024-01".into(), end: None };
        assert!(recency_decay(&open, 2024, 1) > 0.99);
        let junk = DateRange { start: "present".into(), end: None };
        assert_eq!(recency_decay(&junk, 2026, 1), 0.5);
        let empty = DateRange { start: String::new(), end: Some("  ".into()) };
        assert_eq!(recency_decay(&empty, 2026, 1), 0.5);
        // Future dates clamp rather than exceeding 1.
        let future = DateRange { start: "2030-01".into(), end: Some("2030-01".into()) };
        assert_eq!(recency_decay(&future, 2026, 1), 1.0);
    }

    #[test]
    fn seniority_distance_ladder() {
        assert_eq!(seniority_fit("senior", "senior"), 1.0);
        assert_eq!(seniority_fit("ic", "senior"), 0.7);
        assert_eq!(seniority_fit("ic", "lead"), 0.4);
        assert_eq!(seniority_fit("ic", "director"), 0.15);
        // Unknown levels default to rank 1.
        assert_eq!(seniority_fit("wizard", "senior"), 1.0);
    }

    #[test]
    fn scores_are_a_total_order_and_do_not_saturate() {
        let blocks = vec![
            block("b", &["Python", "Rust"]),
            block("a", &["Python", "Rust"]),
            block("c", &["COBOL"]),
        ];
        let ctx = ScoringContext {
            must_have: &["python".into(), "rust".into()],
            nice_to_have: &[],
            jd_seniority: "senior",
            persona_id: "ai",
            persona_weights: None,
            weights: weights_for(false),
            now_year: 2026,
            now_month: 8,
        };
        let scored = score_blocks(&blocks, &ctx, &HashMap::new());
        // Identical scores break ties by id ascending, so ordering is stable.
        assert_eq!(scored[0].block.id, "a");
        assert_eq!(scored[1].block.id, "b");
        assert_eq!(scored[2].block.id, "c");
        // The unrelated block must score strictly lower, not tie at a ceiling.
        assert!(scored[1].score > scored[2].score);
        for s in &scored {
            assert!((0.0..=1.0).contains(&s.score), "score out of range: {}", s.score);
        }
    }

    #[test]
    fn embedding_scores_are_clamped_and_nan_safe() {
        let b = block("x", &["Python"]);
        let ctx = ScoringContext {
            must_have: &["python".into()],
            nice_to_have: &[],
            jd_seniority: "senior",
            persona_id: "ai",
            persona_weights: None,
            weights: weights_for(true),
            now_year: 2026,
            now_month: 8,
        };
        assert_eq!(hybrid_score(&b, &ctx, f64::NAN).components.embedding, 0.0);
        assert_eq!(hybrid_score(&b, &ctx, 5.0).components.embedding, 1.0);
        assert_eq!(hybrid_score(&b, &ctx, -5.0).components.embedding, 0.0);
        assert!(hybrid_score(&b, &ctx, f64::INFINITY).score.is_finite());
    }

    #[test]
    fn persona_weights_boost_but_never_below_half() {
        let s = vec![skill("Python")];
        let mut pw = HashMap::new();
        pw.insert("python".to_string(), 0.1);
        // Boost is floored at 0.5, so a tiny weight cannot erase the hit.
        let v = skill_overlap(&s, &["python".into()], &[], Some(&pw));
        assert!((v - 0.5).abs() < 1e-9, "got {v}");
    }

    #[test]
    fn blocks_with_no_bullets_or_skills_do_not_panic() {
        let mut b = block("empty", &[]);
        b.bullets = vec![Bullet {
            id: "b1".into(),
            canonical: String::new(),
            variants: serde_json::Map::new(),
            metrics: vec![],
            evidence_refs: vec![],
            locked: false,
        }];
        let ctx = ScoringContext {
            must_have: &[],
            nice_to_have: &[],
            jd_seniority: "",
            persona_id: "",
            persona_weights: None,
            weights: weights_for(false),
            now_year: 2026,
            now_month: 8,
        };
        let s = hybrid_score(&b, &ctx, 0.0);
        assert!(s.score.is_finite());
    }

    #[test]
    fn recency_does_not_overflow_on_extreme_years() {
        let r = DateRange { start: "1970-01".into(), end: Some("1970-01".into()) };
        assert!(recency_decay(&r, i32::MAX, 12).is_finite());
        assert!(recency_decay(&r, i32::MIN, 1).is_finite());
    }

    #[test]
    fn persona_only_scoring_is_deterministic_and_nan_safe() {
        let s = vec![skill("Python"), skill("Rust")];
        let mut pw = HashMap::new();
        for (k, v) in [("python", 1.0), ("rust", 2.0), ("cobol", 3.0), ("bad", f64::NAN)] {
            pw.insert(k.to_string(), v);
        }
        let first = skill_overlap(&s, &[], &[], Some(&pw));
        for _ in 0..50 {
            assert_eq!(skill_overlap(&s, &[], &[], Some(&pw)), first);
        }
        assert!(first.is_finite());
        assert!((0.0..=1.0).contains(&first));
    }

    #[test]
    fn a_non_finite_persona_weight_does_not_erase_a_match() {
        let s = vec![skill("Python")];
        let mut pw = HashMap::new();
        pw.insert("python".to_string(), f64::NAN);
        // Falls back to weight 1.0 rather than propagating NaN.
        assert_eq!(skill_overlap(&s, &["python".into()], &[], Some(&pw)), 1.0);
    }
}
