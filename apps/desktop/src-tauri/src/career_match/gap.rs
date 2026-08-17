//! Must-have gap analysis and ATS coverage.
//!
//! Faithful Rust port of `src/lib/resume-synthesis/gap-analysis.ts` plus
//! `computeAtsCoveragePct` from `critic.ts`.
//!
//! # The defect this replaces
//!
//! The MCP `resume_gap_analysis` tool considered a skill covered only if it
//! appeared in `block.skills`, ignoring domains, bullets and the entire fact
//! pool, and it compared with bidirectional `contains` so "go" matched
//! "mongodb". The canonical analysis searches four sources per block and
//! classifies each must-have as covered / weak / missing. Separately,
//! `resume_synthesize` reported a hardcoded `coveragePercentage: 88.0`; real
//! ATS coverage is computed here.

use crate::career_db::ExperienceBlock;
use serde::Serialize;

use super::text::{skills_match, text_covers_skill};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GapStatus {
    Covered,
    Weak,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GapHitKind {
    BlockSkill,
    BlockDomain,
    Bullet,
    Fact,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapHit {
    pub kind: GapHitKind,
    pub block_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bullet_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fact_id: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapAnalysisItem {
    pub skill: String,
    pub status: GapStatus,
    pub evidence: Vec<String>,
    pub selected_hits: Vec<GapHit>,
    pub pool_hits: Vec<GapHit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapAnalysis {
    pub items: Vec<GapAnalysisItem>,
    pub summary: String,
    pub covered_count: usize,
    pub weak_count: usize,
    pub missing_count: usize,
    /// Percentage of must-haves with status `covered`, rounded.
    pub coverage_percentage: u32,
}

/// Trim and collapse whitespace, then clip with an ellipsis. Port of `snippet`.
fn snippet(text: &str, max: usize) -> String {
    let collapsed: String = {
        let mut out = String::with_capacity(text.len());
        let mut in_ws = false;
        for c in text.trim().chars() {
            if c.is_whitespace() {
                if !in_ws {
                    out.push(' ');
                    in_ws = true;
                }
            } else {
                out.push(c);
                in_ws = false;
            }
        }
        out
    };
    if collapsed.chars().count() <= max {
        return collapsed;
    }
    let mut s: String = collapsed.chars().take(max.saturating_sub(1)).collect();
    s.push('…');
    s
}

/// Collect evidence for a skill within one block: skill tags, domains, bullets
/// and facts. All four sources, which is the point.
pub fn collect_block_skill_hits(block: &ExperienceBlock, skill: &str) -> Vec<GapHit> {
    let mut hits = Vec::new();
    if skill.trim().is_empty() {
        return hits;
    }

    for s in &block.skills {
        if skills_match(&s.name, skill) {
            hits.push(GapHit {
                kind: GapHitKind::BlockSkill,
                block_id: block.id.clone(),
                bullet_id: None,
                fact_id: None,
                text: s.name.clone(),
            });
        }
    }

    for d in &block.domains {
        if skills_match(d, skill) || text_covers_skill(d, skill) {
            hits.push(GapHit {
                kind: GapHitKind::BlockDomain,
                block_id: block.id.clone(),
                bullet_id: None,
                fact_id: None,
                text: d.clone(),
            });
        }
    }

    for b in &block.bullets {
        if text_covers_skill(&b.canonical, skill) {
            hits.push(GapHit {
                kind: GapHitKind::Bullet,
                block_id: block.id.clone(),
                bullet_id: Some(b.id.clone()),
                fact_id: None,
                text: snippet(&b.canonical, 80),
            });
        }
    }

    for f in &block.facts {
        let skill_hit = f.skills.iter().any(|s| skills_match(s, skill));
        let text_hit = text_covers_skill(&f.text, skill);
        if skill_hit || text_hit {
            // At most one hit per fact, matching the canonical behaviour.
            hits.push(GapHit {
                kind: GapHitKind::Fact,
                block_id: block.id.clone(),
                bullet_id: None,
                fact_id: Some(f.id.clone()),
                text: snippet(&f.text, 80),
            });
        }
    }

    hits
}

fn evidence_labels(selected: &[GapHit], pool: &[GapHit]) -> Vec<String> {
    // Deduplicate BEFORE limiting. Taking the first 6 hits and then dropping
    // duplicates starved the panel: six hits on the same skill tag yielded one
    // label while genuinely distinct evidence went unshown.
    let mut out: Vec<String> = Vec::new();
    for h in selected.iter().chain(pool.iter()) {
        if out.len() >= 6 {
            break;
        }
        if !h.text.trim().is_empty() && !out.contains(&h.text) {
            out.push(h.text.clone());
        }
    }
    out
}

/// Classify every must-have skill against selected and pool blocks.
pub fn analyze_must_have_gaps(
    must_have_skills: &[String],
    selected_blocks: &[ExperienceBlock],
    pool_blocks: &[ExperienceBlock],
) -> GapAnalysis {
    let selected_ids: Vec<&str> = selected_blocks.iter().map(|b| b.id.as_str()).collect();
    let non_selected: Vec<&ExperienceBlock> = pool_blocks
        .iter()
        .filter(|b| !selected_ids.contains(&b.id.as_str()))
        .collect();

    let items: Vec<GapAnalysisItem> = must_have_skills
        .iter()
        .map(|skill| {
            let selected_hits: Vec<GapHit> = selected_blocks
                .iter()
                .flat_map(|b| collect_block_skill_hits(b, skill))
                .collect();
            let pool_hits: Vec<GapHit> = non_selected
                .iter()
                .flat_map(|b| collect_block_skill_hits(b, skill))
                .collect();

            let status = if !selected_hits.is_empty() {
                GapStatus::Covered
            } else if !pool_hits.is_empty() {
                GapStatus::Weak
            } else {
                GapStatus::Missing
            };

            GapAnalysisItem {
                skill: skill.clone(),
                status,
                evidence: evidence_labels(&selected_hits, &pool_hits),
                selected_hits,
                pool_hits,
            }
        })
        .collect();

    let covered_count = items.iter().filter(|i| i.status == GapStatus::Covered).count();
    let weak_count = items.iter().filter(|i| i.status == GapStatus::Weak).count();
    let missing_count = items.iter().filter(|i| i.status == GapStatus::Missing).count();

    let summary = if must_have_skills.is_empty() {
        "No must-have skills extracted from the JD.".to_string()
    } else {
        let mut parts: Vec<String> = Vec::new();
        if covered_count > 0 {
            parts.push(format!("{covered_count} covered"));
        }
        if weak_count > 0 {
            parts.push(format!("{weak_count} weak"));
        }
        if missing_count > 0 {
            parts.push(format!("{missing_count} missing"));
        }
        format!("Must-haves: {}.", parts.join(", "))
    };

    // Denominator is the must-have count, so an empty JD yields 0 rather than
    // a divide-by-zero or a flattering 100.
    let coverage_percentage = if must_have_skills.is_empty() {
        0
    } else {
        ((100.0 * covered_count as f64) / must_have_skills.len() as f64).round() as u32
    };

    GapAnalysis {
        items,
        summary,
        covered_count,
        weak_count,
        missing_count,
        coverage_percentage,
    }
}

/// Programmatic ATS coverage: the fraction of JD ATS keywords that appear, with
/// word-boundary matching, in the final bullet text or skill names.
///
/// Port of `computeAtsCoveragePct`. Returns 0 for an empty keyword list or an
/// empty corpus, never a placeholder.
pub fn compute_ats_coverage_pct(
    bullet_texts: &[String],
    skill_names: &[String],
    ats_keywords: &[String],
) -> u32 {
    let keywords: Vec<&String> = ats_keywords.iter().filter(|k| !k.trim().is_empty()).collect();
    if keywords.is_empty() {
        return 0;
    }
    let mut parts: Vec<&str> = Vec::new();
    for t in bullet_texts {
        if !t.trim().is_empty() {
            parts.push(t);
        }
    }
    for s in skill_names {
        if !s.trim().is_empty() {
            parts.push(s);
        }
    }
    let corpus = parts.join("\n");
    if corpus.trim().is_empty() {
        return 0;
    }
    let hits = keywords.iter().filter(|kw| text_covers_skill(&corpus, kw)).count();
    ((100.0 * hits as f64) / keywords.len() as f64).round() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::career_db::{BlockFact, Bullet, DateRange, ExperienceBlock, SkillTag};

    fn blk(id: &str) -> ExperienceBlock {
        ExperienceBlock {
            id: id.to_string(),
            kind: "experience".into(),
            title: "Engineer".into(),
            org: "Org".into(),
            date_range: DateRange { start: "2023-01".into(), end: None },
            personas: vec![],
            domains: vec![],
            skills: vec![],
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

    fn fact(id: &str, text: &str, skills: &[&str]) -> BlockFact {
        BlockFact {
            id: id.to_string(),
            text: text.to_string(),
            skills: skills.iter().map(|s| s.to_string()).collect(),
            metrics: vec![],
            source: "manual".into(),
            created_at: "0".into(),
        }
    }

    fn bul(id: &str, text: &str) -> Bullet {
        Bullet {
            id: id.to_string(),
            canonical: text.to_string(),
            variants: serde_json::Map::new(),
            metrics: vec![],
            evidence_refs: vec![],
            locked: false,
        }
    }

    /// Defect #8: coverage must consider all four sources, not just skill tags.
    #[test]
    fn coverage_is_found_in_bullets_domains_and_facts_not_only_skill_tags() {
        let mut b = blk("a");
        b.bullets = vec![bul("b1", "shipped Kubernetes operators")];
        assert_eq!(collect_block_skill_hits(&b, "kubernetes").len(), 1);

        let mut d = blk("b");
        d.domains = vec!["machine learning".into()];
        assert_eq!(collect_block_skill_hits(&d, "machine learning").len(), 1);

        let mut f = blk("c");
        f.facts = vec![fact("f1", "Ran a Rust migration across 12 crates", &[])];
        assert_eq!(collect_block_skill_hits(&f, "rust").len(), 1);

        let mut fs = blk("d");
        fs.facts = vec![fact("f2", "unrelated prose", &["PyTorch"])];
        assert_eq!(collect_block_skill_hits(&fs, "pytorch").len(), 1);
    }

    #[test]
    fn a_fact_matching_on_both_skill_and_text_yields_one_hit() {
        let mut b = blk("a");
        b.facts = vec![fact("f1", "deep Rust experience", &["Rust"])];
        let hits = collect_block_skill_hits(&b, "rust");
        assert_eq!(hits.len(), 1, "fact double-counted: {hits:?}");
    }

    #[test]
    fn substring_collisions_do_not_create_coverage() {
        let mut b = blk("a");
        b.skills = vec![SkillTag { name: "MongoDB".into(), level: 3, years: None }];
        b.bullets = vec![bul("b1", "ran mongodb clusters")];
        assert!(collect_block_skill_hits(&b, "go").is_empty());
    }

    #[test]
    fn status_ladder_covered_weak_missing() {
        let mut selected = blk("sel");
        selected.skills = vec![SkillTag { name: "Rust".into(), level: 4, years: None }];
        let mut pool = blk("pool");
        pool.bullets = vec![bul("p1", "some Python scripting")];

        let g = analyze_must_have_gaps(
            &["rust".into(), "python".into(), "fortran".into()],
            &[selected.clone()],
            &[selected, pool],
        );
        assert_eq!(g.items[0].status, GapStatus::Covered);
        assert_eq!(g.items[1].status, GapStatus::Weak);
        assert_eq!(g.items[2].status, GapStatus::Missing);
        assert_eq!(g.covered_count, 1);
        assert_eq!(g.weak_count, 1);
        assert_eq!(g.missing_count, 1);
        assert_eq!(g.coverage_percentage, 33);
        assert_eq!(g.summary, "Must-haves: 1 covered, 1 weak, 1 missing.");
    }

    #[test]
    fn empty_must_haves_report_zero_not_one_hundred() {
        let g = analyze_must_have_gaps(&[], &[], &[]);
        assert_eq!(g.coverage_percentage, 0);
        assert_eq!(g.summary, "No must-have skills extracted from the JD.");
        assert!(g.items.is_empty());
    }

    #[test]
    fn ats_coverage_is_computed_not_hardcoded() {
        let bullets = vec!["Built Rust services on Kubernetes".to_string()];
        let skills = vec!["Python".to_string()];
        let kws = vec!["rust".to_string(), "kubernetes".to_string(), "python".to_string(), "cobol".to_string()];
        assert_eq!(compute_ats_coverage_pct(&bullets, &skills, &kws), 75);
    }

    #[test]
    fn ats_coverage_edge_cases_return_zero() {
        assert_eq!(compute_ats_coverage_pct(&[], &[], &[]), 0);
        assert_eq!(compute_ats_coverage_pct(&["text".into()], &[], &[]), 0);
        assert_eq!(compute_ats_coverage_pct(&[], &[], &["rust".into()]), 0);
        assert_eq!(compute_ats_coverage_pct(&["   ".into()], &["  ".into()], &["rust".into()]), 0);
        // Whitespace-only keywords are ignored entirely.
        assert_eq!(compute_ats_coverage_pct(&["rust".into()], &[], &["  ".into()]), 0);
    }

    #[test]
    fn ats_coverage_never_exceeds_one_hundred() {
        let bullets = vec!["rust rust rust".to_string()];
        let kws = vec!["rust".to_string()];
        assert_eq!(compute_ats_coverage_pct(&bullets, &[], &kws), 100);
    }

    #[test]
    fn snippet_collapses_whitespace_and_clips() {
        assert_eq!(snippet("  a   b  ", 80), "a b");
        let long = "x".repeat(200);
        let s = snippet(&long, 80);
        assert_eq!(s.chars().count(), 80);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn blank_skill_never_matches_anything() {
        let mut b = blk("a");
        b.skills = vec![SkillTag { name: "Rust".into(), level: 3, years: None }];
        assert!(collect_block_skill_hits(&b, "").is_empty());
        assert!(collect_block_skill_hits(&b, "   ").is_empty());
    }

    #[test]
    fn evidence_deduplicates_before_limiting() {
        let mut b = blk("a");
        // Six identical-text hits plus one distinct: the distinct one must show.
        b.skills = (0..6)
            .map(|_| SkillTag { name: "Rust".into(), level: 3, years: None })
            .collect();
        b.domains = vec!["rust systems".into()];
        let g = analyze_must_have_gaps(&["rust".into()], &[b.clone()], &[b]);
        let ev = &g.items[0].evidence;
        assert!(ev.len() >= 2, "distinct evidence was starved: {ev:?}");
        assert!(ev.len() <= 6);
    }
}
