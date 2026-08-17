//! Tests for the deterministic résumé-matching core.
//!
//! Several of these are regression tests for defects that shipped in the
//! pre-port MCP heuristics; each says which defect it pins.

use super::jd::{self, JdProfile};
use super::metrics::{dropped_metrics, metric_preserved_in_text, metrics_values_preserved};
use super::scoring::{self, ScoreWeights, DEFAULT_WEIGHTS};
use super::selection::{self, SelectionBudget, TrimOptions};
use crate::career_db::{
    Bullet, BulletMetric, DateRange, ExperienceBlock, Persona, SkillTag,
};
use std::collections::HashMap;

// --- Fixtures ------------------------------------------------------------

fn skill(name: &str) -> SkillTag {
    SkillTag { name: name.into(), level: 3, years: None }
}

fn bullet(id: &str, text: &str) -> Bullet {
    Bullet {
        id: id.into(),
        canonical: text.into(),
        variants: serde_json::Map::new(),
        metrics: Vec::new(),
        evidence_refs: Vec::new(),
        locked: false,
    }
}

fn block(id: &str, org: &str, kind: &str) -> ExperienceBlock {
    ExperienceBlock {
        id: id.into(),
        kind: kind.into(),
        title: format!("Engineer at {org}"),
        org: org.into(),
        date_range: DateRange { start: "2022-01".into(), end: None },
        personas: vec!["ai".into()],
        domains: Vec::new(),
        skills: Vec::new(),
        seniority_level: "senior".into(),
        location: None,
        url: None,
        url_label: None,
        extra: None,
        bullets: Vec::new(),
        facts: Vec::new(),
        notes: None,
        embedding_text: None,
        updated_at: "2026-01-01".into(),
    }
}

fn persona() -> Persona {
    Persona {
        id: "ai".into(),
        label: "AI".into(),
        skill_weights: serde_json::Map::new(),
        default_template_id: "typst-ats-single-column".into(),
        section_order: Vec::new(),
        tone_directive: String::new(),
    }
}

fn budget(total_lines: usize) -> SelectionBudget {
    SelectionBudget {
        total_lines,
        per_bullet: 2,
        blocks_per_section: HashMap::new(),
    }
}

// --- Skill matching ------------------------------------------------------

#[test]
fn skills_match_does_not_fire_on_substrings() {
    // The pre-port MCP gap analysis used `a.contains(b) || b.contains(a)`,
    // so "go" matched "Django" and "java" matched "JavaScript".
    assert!(!scoring::skills_match("JavaScript", "Java"));
    assert!(!scoring::skills_match("Django", "Go"));
    assert!(!scoring::skills_match("Cargo", "Go"));
    assert!(!scoring::skills_match("Rust", "R"));
}

#[test]
fn skills_match_resolves_aliases_both_ways() {
    assert!(scoring::skills_match("JS", "JavaScript"));
    assert!(scoring::skills_match("JavaScript", "js"));
    assert!(scoring::skills_match("k8s", "Kubernetes"));
    assert!(scoring::skills_match("Node", "node.js"));
    assert!(scoring::skills_match("ML", "Machine Learning"));
    assert!(scoring::skills_match("C++", "cpp"));
}

#[test]
fn skills_match_allows_multi_token_subset() {
    assert!(scoring::skills_match("PyTorch", "PyTorch Lightning"));
    assert!(scoring::skills_match("distributed systems", "Distributed Systems"));
}

#[test]
fn text_covers_skill_respects_word_boundaries() {
    assert!(scoring::text_covers_skill("Built services in Go and Rust", "go"));
    assert!(!scoring::text_covers_skill("Built a Django backend", "go"));
    assert!(!scoring::text_covers_skill("Wrote JavaScript all day", "java"));
    // Punctuation-adjacent forms still match.
    assert!(scoring::text_covers_skill("Shipped C++, fast.", "c++"));
    assert!(scoring::text_covers_skill("Used Node.js everywhere", "node.js"));
}

#[test]
fn text_covers_skill_matches_through_aliases() {
    assert!(scoring::text_covers_skill("Deployed on k8s clusters", "kubernetes"));
    assert!(scoring::text_covers_skill("Ran Kubernetes in prod", "k8s"));
}

// --- Weights and components ---------------------------------------------

#[test]
fn default_weights_sum_to_one() {
    let w = DEFAULT_WEIGHTS;
    let sum = w.embedding + w.skills + w.persona + w.recency + w.seniority;
    assert!((sum - 1.0).abs() < 1e-9, "weights sum to {sum}");
}

#[test]
fn disabling_embeddings_renormalizes_the_rest() {
    let w = scoring::weights_for_facets(true);
    assert_eq!(w.embedding, 0.0);
    let sum = w.skills + w.persona + w.recency + w.seniority;
    assert!((sum - 1.0).abs() < 1e-9, "renormalized sum is {sum}");
    // Ratios between surviving components are preserved.
    assert!((w.skills / w.persona - 2.0).abs() < 1e-9);
}

#[test]
fn renormalize_handles_all_zero_weights() {
    let w = ScoreWeights { embedding: 0.0, skills: 0.0, persona: 0.0, recency: 0.0, seniority: 0.0 }
        .renormalized();
    assert_eq!(w.skills, 1.0);
}

#[test]
fn must_have_skills_count_double() {
    let skills = vec![skill("Rust")];
    let must = vec!["Rust".to_string()];
    let nice = vec!["Python".to_string()];
    // Rust matches (2 of 2 weight), Python does not (0 of 1) → 2/3.
    let s = scoring::skill_overlap(&skills, &must, &nice, None);
    assert!((s - 2.0 / 3.0).abs() < 1e-9, "got {s}");
}

#[test]
fn persona_affinity_tiers() {
    assert_eq!(scoring::persona_affinity(&["ai".into()], "ai"), 1.0);
    assert_eq!(scoring::persona_affinity(&["mgmt".into()], "ai"), 0.15);
    assert_eq!(scoring::persona_affinity(&[], "ai"), 0.35);
    assert_eq!(scoring::persona_affinity(&["ai".into()], ""), 0.5);
}

#[test]
fn recency_decays_with_a_four_year_half_life() {
    // Exactly four years back → 0.5.
    let s = scoring::recency_decay("2018-06", Some("2022-06"), 2026, 6);
    assert!((s - 0.5).abs() < 1e-9, "got {s}");
    // Open-ended (current role) → ~1.
    let now = scoring::recency_decay("2026-06", None, 2026, 6);
    assert!((now - 1.0).abs() < 1e-9, "got {now}");
    // Unparseable → 0.5 exactly (the documented fallback).
    assert_eq!(scoring::recency_decay("", None, 2026, 6), 0.5);
    assert_eq!(scoring::recency_decay("not-a-date", None, 2026, 6), 0.5);
}

#[test]
fn recency_never_exceeds_one_for_future_dates() {
    let s = scoring::recency_decay("2030-01", None, 2026, 6);
    assert!((0.0..=1.0).contains(&s), "got {s}");
}

#[test]
fn seniority_fit_falls_off_with_distance() {
    assert_eq!(scoring::seniority_fit("senior", "senior"), 1.0);
    assert_eq!(scoring::seniority_fit("senior", "lead"), 0.7);
    assert_eq!(scoring::seniority_fit("ic", "lead"), 0.4);
    assert_eq!(scoring::seniority_fit("ic", "director"), 0.15);
    // Unknown levels sit at "senior" (rank 1), matching the TS `?? 1`.
    assert_eq!(scoring::seniority_fit("wizard", "senior"), 1.0);
}

// --- Metric preservation -------------------------------------------------

#[test]
fn metrics_survive_synonym_rewrites() {
    assert!(metric_preserved_in_text("25%", "Cut latency by 25%"));
    assert!(metric_preserved_in_text("25%", "Cut latency by 25 percent"));
    assert!(metric_preserved_in_text("25%", "Cut latency by 25 pct"));
    assert!(metric_preserved_in_text("25%", "Cut latency by 25.0%"));
    assert!(metric_preserved_in_text("5x", "Delivered a 5x speedup"));
    assert!(metric_preserved_in_text("5x", "Delivered a 5-fold speedup"));
    assert!(metric_preserved_in_text("5x", "Delivered 5 times the throughput"));
    assert!(metric_preserved_in_text("$1.2M", "Saved $1.2M annually"));
    assert!(metric_preserved_in_text("$1.2M", "Saved 1,200,000 dollars"));
    assert!(metric_preserved_in_text("10,000", "Served 10000 requests"));
    assert!(metric_preserved_in_text("10,000", "Served 10k requests"));
    assert!(metric_preserved_in_text("3", "Led three engineers"));
}

#[test]
fn rust_is_strictly_stronger_than_ts_on_scope_expansion() {
    // TypeScript's `metricPreservedInText` short-circuits on
    // `text.includes(v)` for any non-bare-integer metric, so it reports "25%"
    // as preserved inside "125%" — an inflated number passing verification.
    // This port requires a left boundary on every branch.
    assert!(!metric_preserved_in_text("25%", "Cut latency by 125%"));
    assert!(!metric_preserved_in_text("5x", "Delivered a 15x speedup"));
    assert!(!metric_preserved_in_text("$1.2M", "Saved $41.2M annually"));
    // Bare integers were already boundary-checked in TS; keep that.
    assert!(!metric_preserved_in_text("5", "Led 15 engineers"));
    assert!(!metric_preserved_in_text("10", "Served 100 requests"));
}

#[test]
fn metric_scope_expansion_is_rejected_on_the_right_edge_too() {
    assert!(!metric_preserved_in_text("25%", "Cut latency by 251%"));
    assert!(!metric_preserved_in_text("10,000", "Served 100000 requests"));
}

#[test]
fn dropping_a_metric_fails_verification_and_is_reported() {
    let metrics = vec![
        BulletMetric { value: "25%".into(), kind: "percent".into() },
        BulletMetric { value: "3".into(), kind: "count".into() },
    ];
    let kept = "Cut latency 25% across three services";
    assert!(metrics_values_preserved(&metrics, kept));
    assert!(dropped_metrics(&metrics, kept).is_empty());

    let lost = "Dramatically cut latency across the fleet";
    assert!(!metrics_values_preserved(&metrics, lost));
    assert_eq!(dropped_metrics(&metrics, lost), vec!["25%", "3"]);
}

#[test]
fn empty_metric_values_are_vacuously_preserved() {
    assert!(metric_preserved_in_text("", "anything at all"));
    assert!(metric_preserved_in_text("   ", "anything at all"));
}

#[test]
fn non_numeric_metrics_still_require_a_literal_match() {
    assert!(metric_preserved_in_text("sub-second", "Achieved sub-second p99"));
    assert!(!metric_preserved_in_text("sub-second", "Achieved fast responses"));
    assert!(metric_preserved_in_text("p99", "Held p99 under budget"));
    assert!(!metric_preserved_in_text("p99", "Held p999 under budget"));
}

// --- Line estimation and selection --------------------------------------

#[test]
fn bullet_lines_account_for_wrapping() {
    assert_eq!(selection::estimate_bullet_lines("", 95), 1);
    assert_eq!(selection::estimate_bullet_lines(&"a".repeat(95), 95), 1);
    assert_eq!(selection::estimate_bullet_lines(&"a".repeat(96), 95), 2);
    assert_eq!(selection::estimate_bullet_lines(&"a".repeat(285), 95), 3);
    // Width floor of 40 protects against a nonsense template budget.
    assert_eq!(selection::estimate_bullet_lines(&"a".repeat(40), 1), 1);
}

#[test]
fn block_lines_are_two_plus_wrapped_bullets() {
    // The pre-port MCP used `2 + bullets.len()`, which under-counts every
    // bullet that wraps and silently overflows the page budget.
    let mut b = block("b1", "Acme", "experience");
    b.bullets = vec![bullet("x", &"a".repeat(190))]; // 2 wrapped lines
    assert_eq!(selection::estimate_block_lines(&b), 4);

    let mut empty = block("b2", "Acme", "experience");
    empty.bullets = Vec::new();
    assert_eq!(selection::estimate_block_lines(&empty), 3, "floor of 1 bullet line");
}

#[test]
fn budget_from_template_subtracts_fixed_overhead() {
    let b = SelectionBudget::from_template(50, 2, HashMap::new());
    assert_eq!(b.total_lines, 50 - selection::BUDGET_FIXED_OVERHEAD_LINES);
    // Never goes to zero, even for an absurdly small template.
    let tiny = SelectionBudget::from_template(1, 2, HashMap::new());
    assert_eq!(tiny.total_lines, 1);
}

fn scored(id: &str, org: &str, score: f64, kind: &str) -> scoring::ScoredBlock {
    scoring::ScoredBlock {
        block: block(id, org, kind),
        score,
        components: scoring::ScoreComponents {
            embedding: 0.0, skills: 0.0, persona: 0.0, recency: 0.0, seniority: 0.0,
        },
    }
}

#[test]
fn knapsack_respects_the_line_budget() {
    let items = vec![
        scored("a", "OrgA", 0.9, "experience"),
        scored("b", "OrgB", 0.8, "experience"),
        scored("c", "OrgC", 0.7, "experience"),
    ];
    // Each empty block costs 3 lines; budget of 7 fits two.
    let r = selection::knapsack_select(&items, &budget(7), &[], None);
    assert_eq!(r.selected.len(), 2);
    assert_eq!(r.selected[0].block.id, "a", "highest score first");
}

#[test]
fn knapsack_keeps_one_block_per_org_unless_clearly_better() {
    let items = vec![
        scored("a", "Acme", 0.90, "experience"),
        scored("b", "Acme", 0.95, "experience"), // +0.05 < 0.12 gap → rejected
    ];
    let r = selection::knapsack_select(&items, &budget(100), &[], None);
    assert_eq!(r.selected.len(), 1);
    assert_eq!(r.selected[0].block.id, "b", "sorted first, so it is the incumbent");

    let items2 = vec![
        scored("a", "Acme", 0.50, "experience"),
        scored("b", "Acme", 0.99, "experience"),
    ];
    let r2 = selection::knapsack_select(&items2, &budget(100), &[], None);
    assert_eq!(r2.selected.len(), 1);
    assert_eq!(r2.selected[0].block.id, "b");
}

#[test]
fn knapsack_swaps_in_a_block_to_cover_a_must_have() {
    let mut covering = scored("cover", "OrgC", 0.10, "experience");
    covering.block.skills = vec![skill("Kubernetes")];
    let items = vec![
        scored("a", "OrgA", 0.90, "experience"),
        scored("b", "OrgB", 0.80, "experience"),
        covering,
    ];
    // Budget fits exactly two blocks, so covering Kubernetes needs a swap.
    let must = vec!["Kubernetes".to_string()];
    let r = selection::knapsack_select(&items, &budget(7), &must, None);
    assert!(
        r.selected.iter().any(|s| s.block.id == "cover"),
        "must-have swap did not happen: {:?}",
        r.selected.iter().map(|s| &s.block.id).collect::<Vec<_>>()
    );
    assert!(r.uncovered_must_haves.is_empty());
    assert_eq!(r.swaps.len(), 1);
    assert_eq!(r.swaps[0].skill, "Kubernetes");
}

#[test]
fn uncoverable_must_haves_are_reported_not_hidden() {
    let items = vec![scored("a", "OrgA", 0.9, "experience")];
    let must = vec!["Fortran".to_string()];
    let r = selection::knapsack_select(&items, &budget(100), &must, None);
    assert_eq!(r.uncovered_must_haves, vec!["Fortran"]);
}

#[test]
fn selection_respects_per_section_caps() {
    let mut caps = HashMap::new();
    caps.insert("projects".to_string(), 1usize);
    let b = SelectionBudget { total_lines: 100, per_bullet: 2, blocks_per_section: caps };
    let items = vec![
        scored("p1", "O1", 0.9, "project"),
        scored("p2", "O2", 0.8, "project"),
        scored("p3", "O3", 0.7, "project"),
    ];
    let r = selection::knapsack_select(&items, &b, &[], None);
    assert_eq!(r.selected.len(), 1, "projects cap is 1");
    assert!(selection::budget_violations(&r.selected, &b).is_empty());
}

#[test]
fn budget_violations_flags_an_overpacked_selection() {
    let items = vec![
        scored("a", "OrgA", 0.9, "experience"),
        scored("b", "OrgB", 0.8, "experience"),
    ];
    let v = selection::budget_violations(&items, &budget(4));
    assert!(!v.is_empty(), "6 lines in a 4-line budget must be flagged");
}

#[test]
fn trim_keeps_locked_bullets_and_ranks_the_rest() {
    let mut item = scored("a", "OrgA", 0.9, "experience");
    let mut locked = bullet("locked", "Locked bullet");
    locked.locked = true;
    item.block.bullets = vec![
        bullet("b1", "Irrelevant work"),
        bullet("b2", "Shipped Kubernetes operators"),
        bullet("b3", "More irrelevant work"),
        bullet("b4", "Even more filler"),
        locked,
    ];
    let relevance = HashMap::new();
    let must = vec!["Kubernetes".to_string()];
    let out = selection::trim_selected_bullets(
        &[item],
        &TrimOptions {
            max_bullets_per_block: 2,
            relevance_by_bullet_id: &relevance,
            must_have_skills: &must,
        },
    );
    let ids: Vec<&str> = out[0].block.bullets.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"locked"), "locked bullet must survive: {ids:?}");
    assert!(ids.contains(&"b2"), "must-have bullet should be preferred: {ids:?}");
    assert_eq!(ids.len(), 2);
    // Original order is preserved among kept bullets.
    assert_eq!(ids, vec!["b2", "locked"]);
}

#[test]
fn trim_is_a_noop_when_under_budget() {
    let mut item = scored("a", "OrgA", 0.9, "experience");
    item.block.bullets = vec![bullet("b1", "One"), bullet("b2", "Two")];
    let relevance = HashMap::new();
    let out = selection::trim_selected_bullets(
        &[item],
        &TrimOptions {
            max_bullets_per_block: 4,
            relevance_by_bullet_id: &relevance,
            must_have_skills: &[],
        },
    );
    assert_eq!(out[0].block.bullets.len(), 2);
}

// --- Cosine / MMR --------------------------------------------------------

#[test]
fn cosine_matches_hand_computed_values() {
    assert!((selection::cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-9);
    assert!(selection::cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-9);
    // Mismatched lengths and empties are 0, never a panic.
    assert_eq!(selection::cosine_similarity(&[1.0], &[1.0, 2.0]), 0.0);
    assert_eq!(selection::cosine_similarity(&[], &[]), 0.0);
    assert_eq!(selection::cosine_similarity(&[0.0, 0.0], &[0.0, 0.0]), 0.0);
}

#[test]
fn mmr_trades_relevance_for_diversity() {
    let cands = vec![
        selection::MmrCandidate { item: "a", relevance: 0.90, vec: vec![1.0, 0.0] },
        // Near-duplicate of a: high relevance but redundant.
        selection::MmrCandidate { item: "b", relevance: 0.89, vec: vec![1.0, 0.0] },
        selection::MmrCandidate { item: "c", relevance: 0.60, vec: vec![0.0, 1.0] },
    ];
    let picked = selection::mmr_select(&cands, 2, 0.5);
    assert_eq!(picked[0], "a");
    assert_eq!(picked[1], "c", "diversity should beat the near-duplicate");

    // lambda = 1 is pure relevance, so the duplicate wins.
    let greedy = selection::mmr_select(&cands, 2, 1.0);
    assert_eq!(greedy, vec!["a", "b"]);
}

#[test]
fn mmr_handles_degenerate_inputs() {
    let empty: Vec<selection::MmrCandidate<&str>> = Vec::new();
    assert!(selection::mmr_select(&empty, 3, 0.7).is_empty());
    let one = vec![selection::MmrCandidate { item: "a", relevance: 1.0, vec: vec![1.0] }];
    assert!(selection::mmr_select(&one, 0, 0.7).is_empty());
    // Asking for more than exist returns everything, without looping forever.
    assert_eq!(selection::mmr_select(&one, 99, 0.7), vec!["a"]);
}

// --- JD extraction -------------------------------------------------------

const SAMPLE_JD: &str = "Senior Machine Learning Engineer

About the role
You will build and ship inference infrastructure for large language models.

Requirements
- 5+ years with Python and PyTorch
- Strong Kubernetes and Docker experience
- Experience with distributed training

Preferred
- Familiarity with Rust
- Exposure to CUDA kernels
";

#[test]
fn heuristic_extraction_splits_required_from_preferred() {
    let p = jd::extract_heuristic(SAMPLE_JD);
    // The pre-port heuristic took "the first 4 matched skills" as required and
    // dumped the rest into preferred, regardless of what the JD said.
    assert!(p.must_have_skills.contains(&"python".to_string()), "{:?}", p.must_have_skills);
    assert!(p.must_have_skills.contains(&"pytorch".to_string()));
    assert!(p.must_have_skills.contains(&"kubernetes".to_string()));
    assert!(p.nice_to_have_skills.contains(&"rust".to_string()), "{:?}", p.nice_to_have_skills);
    assert!(p.nice_to_have_skills.contains(&"cuda".to_string()));
    assert!(!p.must_have_skills.contains(&"rust".to_string()), "rust is preferred only");
}

#[test]
fn heuristic_extraction_reads_seniority_from_the_title() {
    assert_eq!(jd::extract_heuristic(SAMPLE_JD).seniority, "senior");
    assert_eq!(jd::extract_heuristic("Staff Engineer\n\nDo things.").seniority, "lead");
    assert_eq!(jd::extract_heuristic("Engineering Manager\n\nLead people.").seniority, "manager");
    assert_eq!(jd::extract_heuristic("VP of Engineering\n\nOwn it.").seniority, "director");
}

#[test]
fn seniority_precedence_prefers_the_most_senior_marker() {
    // "Senior Engineering Manager" is a manager role, not an IC senior role.
    assert_eq!(jd::normalize_seniority("Senior Engineering Manager"), "manager");
    assert_eq!(jd::normalize_seniority("Staff Software Engineer"), "lead");
    assert_eq!(jd::normalize_seniority("Sr. Engineer"), "senior");
}

#[test]
fn heuristic_extraction_falls_back_to_whole_document() {
    // No recognizable headings at all — still finds skills rather than none.
    let p = jd::extract_heuristic("We need someone who knows Python and Kubernetes well.");
    assert!(p.must_have_skills.contains(&"python".to_string()));
    assert!(!p.is_extraction_empty());
}

#[test]
fn heuristic_extraction_survives_empty_and_junk_input() {
    let empty = jd::extract_heuristic("");
    assert_eq!(empty.role_title, "Role");
    assert!(empty.is_extraction_empty());

    // Must not panic on multi-byte input or classify nonsense as skills.
    let junk = jd::extract_heuristic("🚀🚀🚀 中文 عربي\n\n\n");
    assert!(junk.must_have_skills.is_empty());
}

#[test]
fn heuristic_extraction_does_not_hallucinate_absent_skills() {
    let p = jd::extract_heuristic("Requirements\n- Strong communication skills\n");
    assert!(
        p.must_have_skills.is_empty(),
        "no technical skill is listed, so none may be reported: {:?}",
        p.must_have_skills
    );
}

#[test]
fn heuristic_extraction_does_not_match_skills_inside_other_words() {
    // "Django" must not yield "go"; "JavaScript" must not yield "java".
    let p = jd::extract_heuristic("Requirements\n- Django and JavaScript experience\n");
    assert!(!p.must_have_skills.contains(&"go".to_string()), "{:?}", p.must_have_skills);
    assert!(!p.must_have_skills.contains(&"java".to_string()), "{:?}", p.must_have_skills);
    assert!(p.must_have_skills.contains(&"javascript".to_string()));
}

#[test]
fn normalize_accepts_an_llm_profile_and_fills_gaps() {
    let raw = serde_json::json!({
        "roleTitle": "  Staff ML Engineer  ",
        "seniority": "Staff",
        "mustHaveSkills": ["Python", "  ", 42, "PyTorch"],
        "atsKeywords": ["inference"],
    });
    let p = jd::normalize(&raw, "Some JD body text");
    assert_eq!(p.role_title, "Staff ML Engineer");
    assert_eq!(p.seniority, "lead");
    assert_eq!(p.must_have_skills, vec!["Python", "PyTorch"], "blanks and non-strings dropped");
    // Missing facet text falls back to a JD slice rather than being empty.
    assert_eq!(p.responsibilities_text, "Some JD body text");
}

#[test]
fn normalize_survives_garbage_input() {
    let p = jd::normalize(&serde_json::json!("not an object"), "body");
    assert_eq!(p.role_title, "Role");
    assert_eq!(p.seniority, "senior");
    assert!(p.must_have_skills.is_empty());
}

#[test]
fn truncate_never_splits_a_multibyte_character() {
    let s = "🚀".repeat(50);
    let t = jd::truncate_chars(&s, 10);
    assert_eq!(t.chars().count(), 10);
    assert!(t.is_char_boundary(t.len()));
}

// --- End-to-end scoring --------------------------------------------------

#[test]
fn score_blocks_orders_by_relevance_and_is_deterministic() {
    let mut relevant = block("relevant", "OrgA", "experience");
    relevant.skills = vec![skill("Python"), skill("PyTorch")];
    let mut irrelevant = block("irrelevant", "OrgB", "experience");
    irrelevant.skills = vec![skill("Salesforce")];

    let profile = JdProfile {
        role_title: "ML Engineer".into(),
        seniority: "senior".into(),
        must_have_skills: vec!["Python".into(), "PyTorch".into()],
        ..Default::default()
    };
    let blocks = vec![irrelevant, relevant];
    let emb = HashMap::new();
    let a = scoring::score_blocks(&blocks, &profile, &persona(), &emb, true, 2026, 6);
    assert_eq!(a[0].block.id, "relevant");

    // Same inputs, same output — no map-iteration nondeterminism.
    let b = scoring::score_blocks(&blocks, &profile, &persona(), &emb, true, 2026, 6);
    let ids_a: Vec<&str> = a.iter().map(|s| s.block.id.as_str()).collect();
    let ids_b: Vec<&str> = b.iter().map(|s| s.block.id.as_str()).collect();
    assert_eq!(ids_a, ids_b);
    assert!(a.iter().zip(b.iter()).all(|(x, y)| x.score == y.score));
}

#[test]
fn every_score_stays_in_range() {
    let mut b = block("x", "Org", "experience");
    b.skills = vec![skill("Python")];
    let profile = JdProfile {
        must_have_skills: vec!["Python".into()],
        seniority: "senior".into(),
        ..Default::default()
    };
    let emb = HashMap::new();
    for disabled in [true, false] {
        let s = scoring::score_blocks(&[b.clone()], &profile, &persona(), &emb, disabled, 2026, 6);
        assert!((0.0..=1.0).contains(&s[0].score), "score {} out of range", s[0].score);
    }
}

// --- Typst emission and injection safety ---------------------------------

use super::language::{
    accept_or_fall_back, verify_rewrite, FallbackReason, RewrittenBullet,
    DEFAULT_PER_BULLET_CHARS as PER_BULLET,
};
use super::typst_emit::{self, HeaderFields, RenderBlock};
use crate::career_typst::engine;

fn rendered(text: &str) -> RewrittenBullet {
    RewrittenBullet {
        id: "b1".into(),
        canonical: text.into(),
        text: text.into(),
        ai_generated: false,
        fallback_reason: None,
        dropped_metrics: Vec::new(),
    }
}

fn header() -> HeaderFields {
    HeaderFields {
        name: "Ada Lovelace".into(),
        email: "ada@example.com".into(),
        phone: String::new(),
        location: "London".into(),
        links: vec!["github.com/ada".into()],
    }
}

#[test]
fn escaping_closes_every_literal() {
    for payload in [
        r#"say "hello""#,
        r"trailing backslash \",
        r#"both \ and " together"#,
        "#read(\"/etc/passwd\")",
        "\\\\\\",
    ] {
        let lit = typst_emit::to_typst_string(payload, 4000);
        assert!(
            typst_emit::validate_typst_string(&lit).is_ok(),
            "payload {payload:?} produced an invalid literal: {lit}"
        );
    }
}

#[test]
fn control_and_bidi_characters_are_stripped() {
    let nasty = "safe\u{202E}reversed\u{200B}zero\u{0007}bell";
    let out = typst_emit::normalize_plain_text(nasty);
    assert_eq!(out, "safereversedzerobell");
}

#[test]
fn newlines_fold_to_single_spaces() {
    assert_eq!(typst_emit::normalize_plain_text("a\n\n\nb"), "a b");
    assert_eq!(typst_emit::normalize_plain_text("a\r\n\tb"), "a b");
}

#[test]
fn unicode_is_preserved_without_nfc() {
    // The NFC pass is deliberately omitted (no normalization dependency).
    // Decomposed input must survive intact rather than being mangled.
    let decomposed = "e\u{0301}cole";
    let out = typst_emit::normalize_plain_text(decomposed);
    assert_eq!(out, decomposed, "combining marks must be preserved verbatim");
    assert!(typst_emit::validate_typst_string(&typst_emit::to_typst_string(decomposed, 4000)).is_ok());
}

#[test]
fn slot_text_is_clamped_not_dropped() {
    let long = "a".repeat(typst_emit::MAX_SLOT_CHARS + 500);
    let out = typst_emit::clamp_slot_text(&long, typst_emit::MAX_SLOT_CHARS);
    assert_eq!(out.chars().count(), typst_emit::MAX_SLOT_CHARS);
    assert!(out.ends_with('…'));
}

#[test]
fn rich_parts_round_trip_without_losing_characters() {
    let input = "plain **bold** more ** unmatched";
    let parts = typst_emit::parse_rich_parts(input);
    let joined: String = parts.iter().map(|p| p.text.as_str()).collect();
    assert_eq!(joined, "plain bold more ** unmatched", "only matched pairs removed");
    assert!(parts.iter().any(|p| p.bold && p.text == "bold"));
}

#[test]
fn dangerous_url_schemes_are_dropped() {
    assert_eq!(typst_emit::to_typst_url("javascript:alert(1)"), "\"\"");
    assert_eq!(typst_emit::to_typst_url("file:///etc/passwd"), "\"\"");
    assert_eq!(typst_emit::to_typst_url("https://example.com"), "\"https://example.com\"");
    // Schemeless input is upgraded rather than rejected.
    assert_eq!(typst_emit::to_typst_url("example.com"), "\"https://example.com\"");
}

#[test]
fn a_rendered_resume_compiles() {
    let mut b = block("b1", "Acme", "experience");
    b.bullets = vec![bullet("b1", "Shipped things")];
    let bs = vec![rendered("Shipped a distributed scheduler, cutting p99 by 25%")];
    let doc = typst_emit::render_resume(
        &header(),
        Some("Engineer with a **decade** of systems work."),
        &["Rust".into(), "Typst".into()],
        &[RenderBlock { block: &b, bullets: &bs }],
    );
    let r = engine::compile_resume_pdf(&doc);
    assert!(r.success, "render failed: {:?}\n---\n{doc}", r.errors);
    assert_eq!(r.page_count, 1);
    assert!(r.pdf_bytes.expect("pdf").starts_with(b"%PDF-"));
}

#[test]
fn injection_payloads_in_resume_text_stay_inert() {
    // Each of these was executable under the old raw-markup interpolation.
    let payloads = [
        "#read(\"/etc/passwd\")",
        "#set page(width: 100000pt)",
        "#import \"@preview/evil:1.0.0\": *",
        "\" + read(\"/etc/passwd\") + \"",
        "#show heading: it => [pwned]",
        "*/ #read(\"/x\") /*",
        "#eval(\"1+1\", mode: \"code\")",
        "] #read(\"/x\") [",
    ];
    for payload in payloads {
        let mut b = block("b1", payload, "experience");
        b.title = payload.to_string();
        b.bullets = vec![bullet("b1", payload)];
        let bs = vec![rendered(payload)];
        let mut h = header();
        h.name = payload.to_string();
        let doc = typst_emit::render_resume(&h, Some(payload), &[payload.to_string()],
            &[RenderBlock { block: &b, bullets: &bs }]);
        let r = engine::compile_resume_pdf(&doc);
        assert!(
            r.success,
            "payload {payload:?} broke compilation (it should render as text): {:?}",
            r.errors
        );
        assert_eq!(r.page_count, 1, "payload {payload:?} changed the page count");
    }
}

#[test]
fn an_empty_resume_still_compiles() {
    let doc = typst_emit::render_resume(&HeaderFields::default(), None, &[], &[]);
    let r = engine::compile_resume_pdf(&doc);
    assert!(r.success, "empty résumé failed: {:?}", r.errors);
}

// --- Rewrite verification ------------------------------------------------

#[test]
fn a_rewrite_that_drops_a_metric_is_rejected() {
    let mut b = bullet("b1", "Cut p99 latency by 25% across 3 services");
    b.metrics = vec![
        BulletMetric { value: "25%".into(), kind: "percent".into() },
        BulletMetric { value: "3".into(), kind: "count".into() },
    ];
    let err = verify_rewrite(&b, "Dramatically improved latency fleet-wide", PER_BULLET).unwrap_err();
    assert_eq!(err.0, FallbackReason::MetricsLost);
    assert_eq!(err.1, vec!["25%", "3"]);

    let out = accept_or_fall_back(&b, Some("Dramatically improved latency fleet-wide"), PER_BULLET);
    assert!(!out.ai_generated, "a rejected rewrite must not be marked AI-generated");
    assert_eq!(out.text, b.canonical, "must fall back to the user's verified text");
    assert_eq!(out.fallback_reason, Some("metrics-lost"));
}

#[test]
fn an_inflated_metric_is_rejected() {
    let mut b = bullet("b1", "Cut latency by 25%");
    b.metrics = vec![BulletMetric { value: "25%".into(), kind: "percent".into() }];
    // The exact failure mode the verifier exists to catch.
    let out = accept_or_fall_back(&b, Some("Cut latency by 125% using Rust"), PER_BULLET);
    assert!(!out.ai_generated);
    assert_eq!(out.fallback_reason, Some("metrics-lost"));
}

#[test]
fn a_faithful_rewrite_is_accepted() {
    let mut b = bullet("b1", "Cut p99 latency by 25% across 3 services");
    b.metrics = vec![
        BulletMetric { value: "25%".into(), kind: "percent".into() },
        BulletMetric { value: "3".into(), kind: "count".into() },
    ];
    let out = accept_or_fall_back(
        &b,
        Some("Reduced p99 latency 25 percent across three production services"),
        PER_BULLET,
    );
    assert!(out.ai_generated, "reason: {:?}", out.fallback_reason);
    assert!(out.fallback_reason.is_none());
}

#[test]
fn locked_bullets_are_never_rewritten() {
    let mut b = bullet("b1", "Exact wording matters here");
    b.locked = true;
    let out = accept_or_fall_back(&b, Some("Some snappier wording"), PER_BULLET);
    assert!(!out.ai_generated);
    assert_eq!(out.fallback_reason, Some("locked"));
    assert_eq!(out.text, "Exact wording matters here");
}

#[test]
fn an_overlong_rewrite_is_rejected() {
    let b = bullet("b1", "Short bullet");
    let long = "x".repeat(400);
    let out = accept_or_fall_back(&b, Some(&long), PER_BULLET);
    assert_eq!(out.fallback_reason, Some("over-budget"));
}

#[test]
fn a_missing_or_empty_candidate_falls_back() {
    let b = bullet("b1", "Original text");
    assert_eq!(accept_or_fall_back(&b, None, PER_BULLET).fallback_reason, Some("llm-failed"));
    assert_eq!(accept_or_fall_back(&b, Some("   "), PER_BULLET).fallback_reason, Some("llm-failed"));
}

#[test]
fn json_is_extracted_from_fenced_or_chatty_output() {
    use super::language::extract_json_object;
    let fenced = "Sure!\n```json\n{\"bullets\":[{\"id\":\"a\",\"text\":\"hi\"}]}\n```\nHope that helps.";
    let v = extract_json_object(fenced).expect("should recover JSON from a fenced reply");
    assert_eq!(v["bullets"][0]["id"], "a");
    // Braces inside strings must not confuse the scanner.
    let tricky = r#"prefix {"text":"a } b","ok":true} suffix"#;
    let t = extract_json_object(tricky).expect("balanced scan");
    assert_eq!(t["ok"], true);
    assert!(extract_json_object("no json here").is_none());
}

#[test]
fn language_provider_parses_and_defaults_safely() {
    use super::language::LanguageProvider;
    assert!(matches!(LanguageProvider::from_args(None), LanguageProvider::Deterministic));
    // An unknown mode degrades to deterministic rather than doing something else.
    let bogus = serde_json::json!({"mode": "gpt-9"});
    assert!(matches!(LanguageProvider::from_args(Some(&bogus)), LanguageProvider::Deterministic));
    let ollama = serde_json::json!({"mode": "ollama", "model": "qwen3.5:27b"});
    let p = LanguageProvider::from_args(Some(&ollama));
    assert_eq!(p.label(), "ollama:qwen3.5:27b");
    assert!(p.is_local(), "a local model must be reported as zero external cost");
    let agent = serde_json::json!({"mode": "agent"});
    assert!(!LanguageProvider::from_args(Some(&agent)).is_local());
}

#[test]
fn truncation_that_would_cut_a_metric_falls_back() {
    // TypeScript truncates after verifying metrics, so a figure sitting past
    // the cut point is silently dropped from an "accepted" bullet.
    let mut b = bullet("b1", &format!("{} and finally 25% better", "y".repeat(200)));
    b.metrics = vec![BulletMetric { value: "25%".into(), kind: "percent".into() }];
    let candidate = format!("{} and finally 25% better", "z".repeat(200));
    let out = accept_or_fall_back(&b, Some(&candidate), 60);
    assert!(!out.ai_generated, "truncation dropped the metric, so this must fall back");
    assert_eq!(out.fallback_reason, Some("over-budget"));
    assert_eq!(out.text, b.canonical);
}

#[test]
fn an_over_budget_bullet_is_truncated_when_canonical_is_also_too_long() {
    // Both over budget and no metric at risk → truncate on a word boundary.
    let b = bullet("b1", &"word ".repeat(60));
    let candidate = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    let out = accept_or_fall_back(&b, Some(candidate), 30);
    assert!(out.ai_generated, "reason: {:?}", out.fallback_reason);
    assert!(out.text.ends_with('…'), "got {:?}", out.text);
    assert!(out.text.chars().count() <= 30, "got {} chars", out.text.chars().count());
    assert!(!out.text.contains("epsilo "), "must not cut mid-word: {:?}", out.text);
}

#[test]
fn an_echoed_canonical_is_not_counted_as_a_rewrite() {
    let b = bullet("b1", "Shipped the thing");
    let out = accept_or_fall_back(&b, Some("  Shipped the thing  "), PER_BULLET);
    assert!(!out.ai_generated, "echoing the input must not count as AI work");
    assert_eq!(out.fallback_reason, Some("no-change"));
}

#[test]
fn a_figure_invented_from_nothing_is_rejected() {
    use super::metrics::introduced_figures;
    // A bullet with NO recorded metrics: `metrics_values_preserved` passes
    // vacuously, so this is the case where a model can attach any number.
    let b = bullet("b1", "Improved throughput across the fleet");
    assert!(b.metrics.is_empty());
    let out = accept_or_fall_back(
        &b,
        Some("Improved throughput by 999% and saved $99.9M across the fleet"),
        PER_BULLET,
    );
    assert!(!out.ai_generated, "an invented figure must never be accepted");
    assert_eq!(out.fallback_reason, Some("fabricated-metric"));
    assert_eq!(out.text, b.canonical);
    assert!(out.dropped_metrics.contains(&"999".to_string()), "{:?}", out.dropped_metrics);

    assert!(introduced_figures("no numbers here", &[], "now with 42").contains(&"42".to_string()));
    assert!(introduced_figures("cut 25% of it", &[], "cut 25 percent of it").is_empty());
}

#[test]
fn legitimate_magnitude_expansion_is_not_flagged_as_fabrication() {
    use super::metrics::introduced_figures;
    let metrics = vec![BulletMetric { value: "$1.2M".into(), kind: "currency".into() }];
    // "1,200,000" is the same figure as "$1.2M", not a new claim.
    assert!(
        introduced_figures("Saved $1.2M", &metrics, "Saved 1,200,000 dollars").is_empty(),
        "a declared metric's expansion must be allowed"
    );
    // "25.0" is the same figure as "25".
    assert!(introduced_figures("cut 25%", &[], "cut 25.0%").is_empty());
    // But a different number is still caught.
    assert!(!introduced_figures("Saved $1.2M", &metrics, "Saved $1.2M and 40 hours").is_empty());
}

#[test]
fn years_and_identifiers_already_in_canonical_are_allowed() {
    // Re-ordering a bullet must not trip the fabrication check.
    use super::metrics::introduced_figures;
    let canonical = "Led 3 engineers on a 2019 migration to HTTP/2";
    assert!(
        introduced_figures(canonical, &[], "Migrated to HTTP/2 in 2019, leading 3 engineers").is_empty()
    );
}
