//! Adversarial stress coverage for the résumé pipeline.
//!
//! Unit tests pin known behaviours. This module attacks the pipeline with
//! generated and hostile input and asserts *invariants* that must hold for
//! every combination, because the failure mode that matters here is not a
//! wrong score — it is a panic in a headless MCP server, a document that
//! silently stops compiling, or a number on a résumé that the user never
//! measured.
//!
//! Invariants under test:
//!
//! 1. Nothing panics, for any input, at any stage.
//! 2. Every score is finite and in [0, 1].
//! 3. Selection never exceeds a section cap, and never exceeds the line budget
//!    unless a single block does so alone.
//! 4. The rendered document always compiles, and always to ≥ 1 page.
//! 5. **No fabricated figures**: every numeric token in a rendered bullet also
//!    appears in that bullet's canonical text. This is the invariant the old
//!    `resume_finetune_bullet` violated by design.
//! 6. Verification is monotone: a bullet is either byte-identical to its
//!    canonical text or it passed `verify_rewrite`.

use std::collections::HashMap;

use crate::career_db::{
    Bullet, BulletMetric, DateRange, ExperienceBlock, Persona, SkillTag,
};
use crate::career_typst::engine;

use super::jd::{self, JdProfile};
use super::language::{accept_or_fall_back, RewrittenBullet, DEFAULT_PER_BULLET_CHARS};
use super::metrics::numeric_tokens;
use super::selection::{self, SelectionBudget, TrimOptions};
use super::typst_emit::{self, HeaderFields, RenderBlock};
use super::{now_year_month, scoring};

/// Deterministic LCG. A fixed seed keeps a failure reproducible; no `rand`
/// dependency is added for test-only randomness.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // Numerical Recipes LCG constants.
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 16
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// Text fragments chosen to break naive string handling.
const HOSTILE_TEXT: &[&str] = &[
    "",
    " ",
    "#read(\"/etc/passwd\")",
    "#set page(width: 100000pt)",
    "#import \"@preview/evil:1.0.0\": *",
    "\" + read(\"/etc/passwd\") + \"",
    "] #eval(\"1+1\") [",
    "back\\slash and \"quote\"",
    "trailing backslash \\",
    "\u{202E}reversed\u{202C} text",
    "zero\u{200B}width\u{FEFF}joiner",
    "bell\u{0007}and\u{0000}nul",
    "🚀 építész 中文 عربي हिन्दी",
    "e\u{0301}\u{0302}\u{0303} stacked combining marks",
    "line\nbreak\r\nand\ttab",
    "עברית ואנגלית mixed RTL",
    "a very long run: ",
    "**bold** and **unclosed",
    "100% of 100% of 100%",
    "$1.2M / 25% / 5x / 10,000",
];

const SKILL_POOL: &[&str] = &[
    "Rust", "TypeScript", "Python", "Go", "Kubernetes", "PyTorch", "SQLite",
    "Distributed Systems", "C++", "React", "Machine Learning", "Terraform",
];

const KINDS: &[&str] = &["experience", "project", "education", "leadership", "publication", "unknown-kind"];

const DATES: &[(&str, Option<&str>)] = &[
    ("2024-01", None),
    ("2019-06", Some("2022-12")),
    ("", None),
    ("not-a-date", Some("also-not")),
    ("1969-01", Some("1970-01")),
    ("2099-12", None),
    ("2020", Some("2021")),
    ("2020-13", Some("2020-00")),
];

const METRIC_VALUES: &[&str] = &["25%", "5x", "$1.2M", "10,000", "3", "", "p99", "0", "99.99%"];

fn gen_bullet(rng: &mut Rng, i: usize) -> Bullet {
    let mut text = rng.pick(HOSTILE_TEXT).to_string();
    if text == "a very long run: " {
        text.push_str(&"lorem ipsum ".repeat(rng.below(200) + 1));
    }
    let n_metrics = rng.below(3);
    let metrics: Vec<BulletMetric> = (0..n_metrics)
        .map(|_| BulletMetric {
            value: rng.pick(METRIC_VALUES).to_string(),
            kind: "generated".into(),
        })
        .collect();
    // A metric the text does not contain is realistic (stale KB data) and must
    // not crash anything.
    Bullet {
        id: format!("bullet-{i}"),
        canonical: text,
        variants: serde_json::Map::new(),
        metrics,
        evidence_refs: Vec::new(),
        locked: rng.below(5) == 0,
    }
}

fn gen_block(rng: &mut Rng, i: usize) -> ExperienceBlock {
    let (start, end) = *rng.pick(DATES);
    let n_bullets = rng.below(7);
    let n_skills = rng.below(5);
    ExperienceBlock {
        id: format!("block-{i}"),
        kind: rng.pick(KINDS).to_string(),
        title: rng.pick(HOSTILE_TEXT).to_string(),
        // Repeated orgs exercise the one-block-per-org rule.
        org: format!("Org {}", rng.below(4)),
        date_range: DateRange {
            start: start.to_string(),
            end: end.map(str::to_string),
        },
        personas: if rng.below(3) == 0 { Vec::new() } else { vec!["ai".into()] },
        domains: (0..rng.below(3)).map(|_| rng.pick(HOSTILE_TEXT).to_string()).collect(),
        skills: (0..n_skills)
            .map(|_| SkillTag {
                name: rng.pick(SKILL_POOL).to_string(),
                level: (rng.below(6)) as u8,
                years: None,
            })
            .collect(),
        seniority_level: rng
            .pick(&["ic", "senior", "lead", "manager", "director", "wizard", ""])
            .to_string(),
        location: None,
        url: None,
        url_label: None,
        extra: None,
        bullets: (0..n_bullets).map(|b| gen_bullet(rng, i * 100 + b)).collect(),
        facts: Vec::new(),
        notes: None,
        embedding_text: None,
        updated_at: "2026-01-01".into(),
    }
}

fn gen_jd(rng: &mut Rng) -> String {
    let mut s = String::new();
    s.push_str(rng.pick(&[
        "Senior Rust Engineer", "Staff ML Engineer", "Engineering Manager",
        "", "Director of Platform", "🚀🚀🚀",
    ]));
    s.push_str("\n\nRequirements\n");
    for _ in 0..rng.below(5) {
        s.push_str(&format!("- {}\n", rng.pick(SKILL_POOL)));
    }
    s.push_str("\nPreferred\n");
    for _ in 0..rng.below(4) {
        s.push_str(&format!("- {}\n", rng.pick(SKILL_POOL)));
    }
    s.push_str(rng.pick(HOSTILE_TEXT));
    s
}

fn persona() -> Persona {
    let mut weights = serde_json::Map::new();
    weights.insert("Rust".into(), serde_json::json!(1.5));
    weights.insert("Go".into(), serde_json::json!(-0.5));
    weights.insert("bogus".into(), serde_json::json!("not a number"));
    Persona {
        id: "ai".into(),
        label: "AI".into(),
        skill_weights: weights,
        default_template_id: "typst-ats-single-column".into(),
        section_order: Vec::new(),
        tone_directive: String::new(),
    }
}

/// Invariant 5: a rendered bullet may not contain a figure its canonical text
/// does not. This is what makes "the pipeline cannot invent a number" checkable
/// rather than aspirational.
fn assert_no_fabricated_figures(b: &RewrittenBullet) {
    let allowed = numeric_tokens(&b.canonical);
    for tok in numeric_tokens(&b.text) {
        assert!(
            allowed.contains(&tok),
            "fabricated figure {tok:?} in rendered bullet {:?}\n  canonical: {:?}",
            b.text,
            b.canonical
        );
    }
}

fn budget() -> SelectionBudget {
    let mut caps = HashMap::new();
    caps.insert("experience".to_string(), 3usize);
    caps.insert("projects".to_string(), 2usize);
    caps.insert("education".to_string(), 2usize);
    SelectionBudget::from_template(55, DEFAULT_PER_BULLET_CHARS, caps)
}

/// One full deterministic pass: JD → profile → score → select → trim →
/// (canonical) rewrite → render → compile, asserting every invariant.
fn run_case(seed: u64) {
    let mut rng = Rng(seed);
    let jd_text = gen_jd(&mut rng);
    let profile: JdProfile = jd::extract_heuristic(&jd_text);

    let n_blocks = rng.below(12);
    let blocks: Vec<ExperienceBlock> = (0..n_blocks).map(|i| gen_block(&mut rng, i)).collect();

    let (year, month) = now_year_month();
    let embeddings = HashMap::new();
    let scored = scoring::score_blocks(
        &blocks, &profile, &persona(), &embeddings, true, year, month,
    );

    // Invariant 2.
    for s in &scored {
        assert!(
            s.score.is_finite() && (0.0..=1.0).contains(&s.score),
            "seed {seed}: score {} out of range for {}",
            s.score,
            s.block.id
        );
        for c in [
            s.components.embedding, s.components.skills, s.components.persona,
            s.components.recency, s.components.seniority,
        ] {
            assert!(c.is_finite() && (0.0..=1.0).contains(&c), "seed {seed}: component {c}");
        }
    }

    let b = budget();
    let result = selection::knapsack_select(&scored, &b, &profile.must_have_skills, None);

    // Invariant 3.
    let violations = selection::budget_violations(&result.selected, &b);
    if !violations.is_empty() {
        let single_oversized = result.selected.len() == 1
            && selection::estimate_block_lines(&result.selected[0].block) > b.total_lines;
        assert!(
            single_oversized,
            "seed {seed}: budget violated with {} blocks: {violations:?}",
            result.selected.len()
        );
    }
    // A selected block is always one that was scored.
    for s in &result.selected {
        assert!(scored.iter().any(|x| x.block.id == s.block.id), "seed {seed}: phantom block");
    }
    // Uncovered must-haves really are uncovered.
    for skill in &result.uncovered_must_haves {
        assert!(
            !result.selected.iter().any(|s| selection::covers_skill(&s.block, skill)),
            "seed {seed}: {skill:?} reported uncovered but a selected block covers it"
        );
    }

    let relevance = HashMap::new();
    let trimmed = selection::trim_selected_bullets(
        &result.selected,
        &TrimOptions {
            max_bullets_per_block: selection::DEFAULT_MAX_BULLETS_PER_BLOCK,
            relevance_by_bullet_id: &relevance,
            must_have_skills: &profile.must_have_skills,
        },
    );
    for (before, after) in result.selected.iter().zip(trimmed.iter()) {
        assert!(
            after.block.bullets.len() <= selection::DEFAULT_MAX_BULLETS_PER_BLOCK
                || before.block.bullets.len() <= selection::DEFAULT_MAX_BULLETS_PER_BLOCK,
            "seed {seed}: trim exceeded the per-block cap"
        );
        // Trim never invents a bullet.
        for bullet in &after.block.bullets {
            assert!(
                before.block.bullets.iter().any(|x| x.id == bullet.id),
                "seed {seed}: trim produced an unknown bullet"
            );
        }
        // Locked bullets always survive.
        for locked in before.block.bullets.iter().filter(|x| x.locked) {
            assert!(
                after.block.bullets.iter().any(|x| x.id == locked.id),
                "seed {seed}: a locked bullet was trimmed away"
            );
        }
    }

    // Rewrite stage in deterministic mode, plus a hostile "model" that tries to
    // inflate every figure — the verifier must reject all of it.
    let rendered: Vec<(ExperienceBlock, Vec<RewrittenBullet>)> = trimmed
        .iter()
        .map(|s| {
            let bullets: Vec<RewrittenBullet> = s
                .block
                .bullets
                .iter()
                .map(|bl| {
                    let hostile = format!("Improved throughput by 999% and saved $99.9M — {}", bl.canonical);
                    accept_or_fall_back(bl, Some(&hostile), DEFAULT_PER_BULLET_CHARS)
                })
                .collect();
            (s.block.clone(), bullets)
        })
        .collect();

    for (_, bullets) in &rendered {
        for bl in bullets {
            // Invariant 5 and 6.
            assert_no_fabricated_figures(bl);
            assert!(
                bl.text == bl.canonical || bl.ai_generated,
                "seed {seed}: text differs from canonical without passing verification"
            );
            if bl.ai_generated {
                assert!(bl.fallback_reason.is_none(), "seed {seed}: accepted bullet carries a reason");
            }
        }
    }

    // Invariant 4.
    let render_blocks: Vec<RenderBlock<'_>> = rendered
        .iter()
        .map(|(block, bullets)| RenderBlock { block, bullets })
        .collect();
    let header = HeaderFields {
        name: HOSTILE_TEXT[seed as usize % HOSTILE_TEXT.len()].to_string(),
        email: "a@b.c".into(),
        phone: String::new(),
        location: "\u{202E}RTL".into(),
        links: vec!["javascript:alert(1)".into(), "example.com".into()],
    };
    let skills: Vec<String> = profile.must_have_skills.clone();
    let doc = typst_emit::render_resume(&header, Some(&jd_text), &skills, &render_blocks);

    let compiled = engine::compile_resume_pdf(&doc);
    assert!(
        compiled.success,
        "seed {seed}: document failed to compile: {:?}\n--- source ---\n{doc}",
        compiled.errors
    );
    assert!(compiled.page_count >= 1, "seed {seed}: rendered zero pages");
    assert!(
        compiled.pdf_bytes.as_ref().is_some_and(|b| b.starts_with(b"%PDF-")),
        "seed {seed}: missing or malformed PDF"
    );
}

#[test]
fn stress_pipeline_over_generated_adversarial_input() {
    // 120 cases exercises every hostile fragment against every block kind,
    // date shape and metric form while staying inside a fast test run.
    for seed in 0..120u64 {
        run_case(seed);
    }
}

#[test]
fn numeric_token_extraction_is_sane() {
    // The fabrication check is only as good as this helper.
    assert_eq!(numeric_tokens("cut 25% of 1,200.50 in 3 ways"), vec!["25", "1,200.50", "3"]);
    assert_eq!(numeric_tokens("no digits here"), Vec::<String>::new());
    assert_eq!(numeric_tokens("p99 and 5x"), vec!["99", "5"]);
}

#[test]
fn the_fabrication_check_actually_catches_fabrication() {
    // Guard against the invariant silently passing because it checks nothing.
    let fabricated = RewrittenBullet {
        id: "b".into(),
        canonical: "Improved latency".into(),
        text: "Improved latency by 25%".into(),
        ai_generated: true,
        fallback_reason: None,
        dropped_metrics: Vec::new(),
    };
    let caught = std::panic::catch_unwind(|| assert_no_fabricated_figures(&fabricated));
    assert!(caught.is_err(), "a fabricated figure must fail the check");
}

#[test]
fn an_enormous_knowledgebase_stays_within_budget() {
    // 500 blocks: selection must still terminate and respect its caps.
    let mut rng = Rng(9_999);
    let blocks: Vec<ExperienceBlock> = (0..500).map(|i| gen_block(&mut rng, i)).collect();
    let profile = jd::extract_heuristic("Requirements\n- Rust\n- Kubernetes\n- PyTorch\n");
    let (year, month) = now_year_month();
    let embeddings = HashMap::new();
    let scored = scoring::score_blocks(&blocks, &profile, &persona(), &embeddings, true, year, month);
    let b = budget();
    let result = selection::knapsack_select(&scored, &b, &profile.must_have_skills, None);
    assert!(result.selected.len() <= 7, "caps allow at most 7 blocks, got {}", result.selected.len());
    let violations = selection::budget_violations(&result.selected, &b);
    assert!(violations.is_empty(), "{violations:?}");
}

#[test]
fn a_pathological_bullet_cannot_blow_up_the_page_count() {
    // A single 200k-character bullet must be clamped by MAX_SLOT_CHARS rather
    // than rendering hundreds of pages.
    let mut block = gen_block(&mut Rng(1), 0);
    block.kind = "experience".into();
    block.bullets = vec![Bullet {
        id: "huge".into(),
        canonical: "word ".repeat(40_000),
        variants: serde_json::Map::new(),
        metrics: Vec::new(),
        evidence_refs: Vec::new(),
        locked: false,
    }];
    let bullets = vec![RewrittenBullet {
        id: "huge".into(),
        canonical: block.bullets[0].canonical.clone(),
        text: block.bullets[0].canonical.clone(),
        ai_generated: false,
        fallback_reason: None,
        dropped_metrics: Vec::new(),
    }];
    let doc = typst_emit::render_resume(
        &HeaderFields::default(),
        None,
        &[],
        &[RenderBlock { block: &block, bullets: &bullets }],
    );
    let compiled = engine::compile_resume_pdf(&doc);
    assert!(compiled.success, "{:?}", compiled.errors);
    assert!(
        compiled.page_count <= 3,
        "MAX_SLOT_CHARS should clamp this to a couple of pages, got {}",
        compiled.page_count
    );
}

#[test]
fn compilation_is_deterministic_across_runs() {
    // Byte-identical output for identical input is what makes "did the résumé
    // actually change?" answerable.
    let mut rng = Rng(42);
    let block = gen_block(&mut rng, 0);
    let bullets: Vec<RewrittenBullet> = block
        .bullets
        .iter()
        .map(|b| RewrittenBullet {
            id: b.id.clone(),
            canonical: b.canonical.clone(),
            text: b.canonical.clone(),
            ai_generated: false,
            fallback_reason: None,
            dropped_metrics: Vec::new(),
        })
        .collect();
    let doc = typst_emit::render_resume(
        &HeaderFields::default(), None, &[],
        &[RenderBlock { block: &block, bullets: &bullets }],
    );
    let a = engine::compile_resume_pdf(&doc).pdf_bytes.expect("a");
    let b = engine::compile_resume_pdf(&doc).pdf_bytes.expect("b");
    assert_eq!(a, b, "identical source must produce identical PDF bytes");
}
