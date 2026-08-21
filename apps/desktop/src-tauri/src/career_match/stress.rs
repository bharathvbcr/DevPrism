//! Adversarial stress harness for the deterministic resume/JD engine.
//!
//! The per-defect regressions across `jd`, `scoring`, `selection`, `gap`,
//! `metrics`, and `render` prove each *known* attack is closed. This file
//! drives the whole pipeline with randomly generated hostile traffic and
//! asserts the properties those fixes exist to protect — so a future change
//! that breaks one by a route nobody thought of still fails.
//!
//! Determinism matters more than entropy: a seeded LCG makes any failure
//! reproducible from the seed printed in the assertion. The generator is a
//! local copy of the one in `mcp::stress` because `career_match` sits below
//! the MCP layer and must not depend on it (the same reason `civil_from_days`
//! above is local rather than shared with the Typst engine).

use super::{gap, jd, metrics, render, scoring, selection};
use crate::career_db::{Bullet, BulletMetric, DateRange, ExperienceBlock, SkillTag};
use serde_json::json;
use std::collections::HashMap;

/// Deterministic PRNG. Numerical Recipes LCG constants.
pub(crate) struct Lcg(u64);

impl Lcg {
    pub(crate) fn new(seed: u64) -> Self {
        // Avoid a zero state, which would make the sequence degenerate.
        Self(seed.wrapping_mul(6364136223846793005).wrapping_add(1))
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }

    pub(crate) fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }

    pub(crate) fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    pub(crate) fn bool(&mut self) -> bool {
        self.next_u64() % 2 == 0
    }

    /// A pseudo-random f64 that is sometimes NaN/infinite/absurd: the exact
    /// values embedding providers and model output actually produce.
    pub(crate) fn hostile_f64(&mut self) -> f64 {
        match self.below(6) {
            0 => f64::NAN,
            1 => f64::INFINITY,
            2 => f64::NEG_INFINITY,
            3 => f64::from_bits(self.next_u64()),
            4 => (self.below(2001) as f64 - 1000.0) / 7.0,
            _ => (self.next_u64() % 1001) as f64 / 1000.0,
        }
    }

    /// A pseudo-random permutation key for shuffling vectors deterministically.
    pub(crate) fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            items.swap(i, self.below(i + 1));
        }
    }
}

/// Strings chosen to break parsing, slicing, matching, and escaping in the
/// engine specifically: date-shaped garbage, Typst code mode, markup splicing,
/// numeric look-alikes, and boundary-hostile Unicode.
pub(crate) const HOSTILE_STRINGS: &[&str] = &[
    "",
    " ",
    "\0",
    "\u{feff}",
    "\u{202e}gnirts desrever",
    "עברית ואנגלית mixed",
    "🙂🙃👨‍👩‍👧‍👦",
    "e\u{0301}\u{0301}\u{0301}",
    "../../../../etc/passwd",
    "'; DROP TABLE blocks; --",
    "%_\\",
    "#let x = 1",
    "#import \"../../evil\": *",
    "#align(center)[#pwned]",
    "[*bold markup*]",
    "${jndi:ldap://evil}",
    "{\"nested\":\"json\"}",
    "-rf",
    "file:///etc/shadow",
    "javascript:alert(1)",
    "2022-01",
    "0000-00",
    "9999-99",
    "-1",
    "2147483647",
    "NaN",
    "inf",
    "5th",
    "%",
];

pub(crate) fn hostile_string(rng: &mut Lcg) -> String {
    let base = rng.pick(HOSTILE_STRINGS).to_string();
    match rng.below(5) {
        0 => base,
        1 => base.repeat(1 + rng.below(3)),
        2 => format!("{base}{}", rng.next_u64()),
        3 => base.to_uppercase(),
        _ => format!("{}\u{00a0}{}", base, base),
    }
}

const KINDS: &[&str] = &[
    "work",
    "experience",
    "project",
    "education",
    "skill_group",
    "leadership",
    "",
    "unknown-kind",
];

const SENIORITIES: &[&str] = &["ic", "senior", "lead", "manager", "director", "", "CTO-level"];

const DATE_SHAPES: &[&str] = &[
    "2022-01",
    "2024-13",
    "0000-00",
    "9999-12",
    "",
    " ",
    "abcd-ef",
    "\0",
    "-1",
    "20-20",
    "2147483648",
    "🙂-01",
];

fn hostile_date(rng: &mut Lcg) -> String {
    if rng.bool() {
        rng.pick(DATE_SHAPES).to_string()
    } else {
        hostile_string(rng)
    }
}

/// An experience block whose every field is adversarial. Ids stay unique
/// because every real caller loads blocks from `career_db`, where `id` is the
/// primary key — colliding ids would attack a precondition no surface can
/// violate rather than anything the engine promises.
pub(crate) fn hostile_block(rng: &mut Lcg, slot: usize) -> ExperienceBlock {
    let id = format!("blk-{slot}");
    let n_bullets = rng.below(6);
    let bullets = (0..n_bullets)
        .map(|b| Bullet {
            id: format!("{id}-b{b}"),
            canonical: hostile_string(rng),
            variants: serde_json::Map::new(),
            metrics: (0..rng.below(3))
                .map(|_| BulletMetric {
                    value: hostile_string(rng),
                    kind: rng.pick(&["percent", "count", "multiplier", ""]).to_string(),
                })
                .collect(),
            evidence_refs: Vec::new(),
            locked: rng.bool(),
        })
        .collect();
    ExperienceBlock {
        id,
        kind: rng.pick(KINDS).to_string(),
        title: hostile_string(rng),
        org: hostile_string(rng),
        date_range: DateRange {
            start: hostile_date(rng),
            end: if rng.bool() { None } else { Some(hostile_date(rng)) },
        },
        personas: (0..rng.below(3)).map(|_| hostile_string(rng)).collect(),
        domains: (0..rng.below(3)).map(|_| hostile_string(rng)).collect(),
        skills: (0..rng.below(3))
            .map(|_| SkillTag {
                name: hostile_string(rng),
                level: rng.below(11) as u8,
                years: if rng.bool() { None } else { Some(rng.hostile_f64()) },
            })
            .collect(),
        seniority_level: rng.pick(SENIORITIES).to_string(),
        location: if rng.bool() { None } else { Some(hostile_string(rng)) },
        url: if rng.bool() { None } else { Some(hostile_string(rng)) },
        url_label: if rng.bool() { None } else { Some(hostile_string(rng)) },
        extra: None,
        bullets,
        facts: Vec::new(),
        notes: if rng.bool() { None } else { Some(hostile_string(rng)) },
        embedding_text: None,
        updated_at: "2026-01-01".to_string(),
    }
}

const HEADINGS: &[&str] = &[
    "Requirements:",
    "Requirements",
    "## Must have",
    "**Nice to have**",
    "nice-to-have:",
    "Responsibilities",
    "Qualifications:",
    "MUST-HAVE SKILLS",
];

const SKILLISH_LINES: &[&str] = &[
    "Rust and Kubernetes",
    "5+ years of Go",
    "go golang Django C++ C# r SRE",
    "deep experience with rust tooling",
    "mongodb go",
];

/// A JD assembled from real headings, real skill lines, and hostile junk, so
/// the extractor's section state machine is attacked from both sides at once.
pub(crate) fn hostile_jd(rng: &mut Lcg) -> String {
    let mut lines: Vec<String> = Vec::new();
    for _ in 0..1 + rng.below(40) {
        match rng.below(10) {
            0..=2 => lines.push(rng.pick(HEADINGS).to_string()),
            3..=5 => lines.push(rng.pick(SKILLISH_LINES).to_string()),
            _ => lines.push(hostile_string(rng)),
        }
    }
    if rng.below(8) == 0 {
        lines.push("x".repeat(1 + rng.below(4000)));
    }
    let sep = if rng.bool() { "\n" } else { "\r\n" };
    lines.join(sep)
}

fn scoring_context<'a>(
    profile: &'a jd::JdProfile,
    persona_id: &'a str,
    now_year: i32,
    now_month: u32,
    semantic_available: bool,
) -> scoring::ScoringContext<'a> {
    scoring::ScoringContext {
        must_have: &profile.must_have_skills,
        nice_to_have: &profile.nice_to_have_skills,
        jd_seniority: &profile.seniority,
        persona_id,
        persona_weights: None,
        weights: scoring::weights_for(semantic_available),
        now_year,
        now_month,
    }
}

fn hostile_embeddings(rng: &mut Lcg, blocks: &[ExperienceBlock]) -> HashMap<String, f64> {
    blocks
        .iter()
        .map(|b| (b.id.clone(), rng.hostile_f64()))
        .collect()
}

/// THE invariant: whatever hostile JD text and whatever hostile blocks a caller
/// throws at the pipeline, every stage is total, scores stay probabilities, the
/// selection honours its own budget, gap accounting adds up, and the rendered
/// document passes the literal audit. A panic here fails the test; so does any
/// stage quietly emitting an out-of-contract value.
#[test]
fn the_engine_pipeline_is_total_under_hostile_traffic() {
    for seed in 0..500u64 {
        let mut rng = Lcg::new(seed);
        let jd_text = hostile_jd(&mut rng);

        // Extraction must be total, deterministic, and only emit well-formed
        // skill entries.
        let extraction = jd::extract_profile(&jd_text);
        let again = jd::extract_profile(&jd_text);
        assert_eq!(
            json!(extraction.profile),
            json!(again.profile),
            "seed {seed}: extraction is not deterministic"
        );
        for list in [
            &extraction.profile.must_have_skills,
            &extraction.profile.nice_to_have_skills,
            &extraction.profile.ats_keywords,
        ] {
            for s in list {
                assert!(!s.trim().is_empty(), "seed {seed}: empty skill extracted");
            }
        }
        let profile = extraction.profile;

        let n_blocks = rng.below(12);
        let blocks: Vec<ExperienceBlock> =
            (0..n_blocks).map(|i| hostile_block(&mut rng, i)).collect();

        let persona_id = if rng.bool() {
            "ai".to_string()
        } else {
            hostile_string(&mut rng)
        };
        let now_year = *rng.pick(&[2026i32, 1970, 0, -5000, i32::MAX, i32::MIN]);
        let now_month = *rng.pick(&[1u32, 6, 8, 12, 0, 99]);
        let ctx = scoring_context(
            &profile,
            &persona_id,
            now_year,
            now_month,
            rng.bool(),
        );
        let embeddings = hostile_embeddings(&mut rng, &blocks);

        let scored = scoring::score_blocks(&blocks, &ctx, &embeddings);
        assert_eq!(scored.len(), blocks.len(), "seed {seed}: scoring dropped blocks");
        for (s, e) in scored.iter().zip(embeddings.values().chain(std::iter::repeat(&0.0))) {
            let _ = e;
            assert!(
                s.score.is_finite() && (0.0..=1.0).contains(&s.score),
                "seed {seed}: score {} out of contract for block '{}'",
                s.score,
                s.block.id
            );
            for c in [
                s.components.embedding,
                s.components.skills,
                s.components.persona,
                s.components.recency,
                s.components.seniority,
            ] {
                assert!(
                    c.is_finite() && (0.0..=1.0).contains(&c),
                    "seed {seed}: score component {c} out of contract"
                );
            }
        }

        let budget = selection::SelectionBudget::for_pages(1 + rng.below(5));
        let sel = selection::knapsack_select(
            &scored,
            &budget,
            &profile.must_have_skills,
            selection::DEFAULT_ORG_SCORE_GAP,
        );

        let ids: std::collections::HashSet<&str> =
            sel.selected.iter().map(|s| s.block.id.as_str()).collect();
        assert_eq!(
            ids.len(),
            sel.selected.len(),
            "seed {seed}: selection emitted a duplicate block id"
        );
        let violations = selection::budget_violations(&sel.selected, &budget);
        assert!(
            violations.is_empty(),
            "seed {seed}: a fresh selection violates its own budget: {violations:?}"
        );

        for s in &sel.selected {
            let kept = selection::trim_selected_bullets(
                &s.block,
                &profile.must_have_skills,
                budget.bullets_per_block(),
            );
            assert!(
                kept.len() <= budget.bullets_per_block(),
                "seed {seed}: bullet trim kept {} over cap {}",
                kept.len(),
                budget.bullets_per_block()
            );
            for id in &kept {
                assert!(
                    s.block.bullets.iter().any(|b| &b.id == id),
                    "seed {seed}: trim invented bullet id '{id}'"
                );
            }
        }

        let selected_blocks: Vec<ExperienceBlock> =
            sel.selected.iter().map(|s| s.block.clone()).collect();
        let gaps = gap::analyze_must_have_gaps(
            &profile.must_have_skills,
            &selected_blocks,
            &blocks,
        );
        assert_eq!(
            gaps.covered_count + gaps.weak_count + gaps.missing_count,
            gaps.items.len(),
            "seed {seed}: gap statuses do not account for every item"
        );
        assert!(
            gaps.coverage_percentage <= 100,
            "seed {seed}: coverage {} exceeds 100",
            gaps.coverage_percentage
        );

        // Render exactly what the MCP synthesis tool would: trimmed bullets
        // only, up to four hostile contact lines.
        let mut bullet_ids_by_block: HashMap<String, Vec<String>> = HashMap::new();
        for s in &sel.selected {
            bullet_ids_by_block.insert(
                s.block.id.clone(),
                selection::trim_selected_bullets(
                    &s.block,
                    &profile.must_have_skills,
                    budget.bullets_per_block(),
                ),
            );
        }
        let contact: Vec<String> = (0..rng.below(5)).map(|_| hostile_string(&mut rng)).collect();
        let doc = render::render_resume(
            &hostile_string(&mut rng),
            &contact,
            &selected_blocks,
            Some(&bullet_ids_by_block),
        );
        assert_eq!(
            render::audit_rendered_literals(&doc),
            None,
            "seed {seed}: rendered document carries an unbalanced literal"
        );
        let doc_again = render::render_resume("same", &["same".to_string()], &selected_blocks, Some(&bullet_ids_by_block));
        let doc_twice = render::render_resume("same", &["same".to_string()], &selected_blocks, Some(&bullet_ids_by_block));
        assert_eq!(doc_again, doc_twice, "rendering is not deterministic");
    }
}

/// Selection must be a function of the *set* of candidates, not their order:
/// the scorer sorts by (score desc, id asc), a total order, so any permutation
/// of the input yields the same selection even under fully hostile content.
#[test]
fn selection_is_permutation_invariant_under_hostile_content() {
    for seed in 0..300u64 {
        let mut rng = Lcg::new(seed ^ 0x5EED);
        let jd_text = hostile_jd(&mut rng);
        let profile = jd::extract_profile(&jd_text).profile;

        let mut blocks: Vec<ExperienceBlock> =
            (0..rng.below(12)).map(|i| hostile_block(&mut rng, i)).collect();

        let run = |blocks: &[ExperienceBlock]| {
            let ctx = scoring_context(&profile, "ai", 2026, 8, false);
            let scored = scoring::score_blocks(blocks, &ctx, &HashMap::new());
            let budget = selection::SelectionBudget::for_pages(2);
            let sel = selection::knapsack_select(
                &scored,
                &budget,
                &profile.must_have_skills,
                selection::DEFAULT_ORG_SCORE_GAP,
            );
            let mut pairs: Vec<(String, u64)> = sel
                .selected
                .iter()
                .map(|s| (s.block.id.clone(), s.score.to_bits()))
                .collect();
            pairs.sort();
            pairs
        };

        let first = run(&blocks);
        rng.shuffle(&mut blocks);
        let second = run(&blocks);
        assert_eq!(
            first, second,
            "seed {seed}: reordering the input changed the selection"
        );
    }
}

/// The rewrite gate exists to stop drafts inventing or losing figures. Under
/// arbitrary hostile metric values and texts it must stay honest: a value
/// genuinely present is never reported dropped, what is reported dropped is
/// always a member of the recorded set, and a verbatim draft never trips the
/// invention detector however hostile the canonical text is.
#[test]
fn the_metric_gate_stays_honest_under_hostile_values_and_texts() {
    use metrics::{dropped_metrics, introduced_numbers, metric_preserved_in_text, metrics_values_preserved};

    for seed in 0..400u64 {
        let mut rng = Lcg::new(seed ^ 0xD1FF);

        let metric_list: Vec<BulletMetric> = (0..rng.below(4))
            .map(|_| BulletMetric {
                value: if rng.bool() {
                    rng.pick(&["25%", "$1.2M", "10,000", "5x", "1.61x", "3"]).to_string()
                } else {
                    hostile_string(&mut rng)
                },
                kind: "percent".to_string(),
            })
            .collect();
        let text = hostile_jd(&mut rng);

        // Totality + consistency between the two reporters.
        let dropped = dropped_metrics(&metric_list, &text);
        let preserved = metrics_values_preserved(&metric_list, &text);
        assert_eq!(
            dropped.is_empty(),
            preserved,
            "seed {seed}: preserved flag and dropped list disagree"
        );
        for d in &dropped {
            assert!(
                metric_list.iter().any(|m| &m.value == d),
                "seed {seed}: reported dropping '{d}', which was never recorded"
            );
        }

        // No false drops for short values genuinely present at boundaries.
        for m in &metric_list {
            let embedded = format!("see {} here", m.value);
            if !m.value.trim().is_empty() && m.value.chars().count() <= 8 {
                assert!(
                    metric_preserved_in_text(&m.value, &embedded),
                    "seed {seed}: '{}' present in '{embedded}' was reported lost",
                    m.value
                );
            }
        }

        // A draft that copies the canonical text verbatim invents nothing,
        // whatever digits the canonical text itself contains.
        let canonical = hostile_jd(&mut rng);
        assert!(
            introduced_numbers(&canonical, &metric_list, &canonical).is_empty(),
            "seed {seed}: a verbatim draft was flagged as inventing numbers"
        );
    }
}
