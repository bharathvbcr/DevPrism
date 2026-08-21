//! Budget-constrained block selection: knapsack, bullet trimming, and the MMR
//! primitive.
//!
//! [`knapsack_select`] packs by score under a line budget with per-section caps,
//! one-entry-per-org de-duplication and must-have coverage repair. It does
//! **not** run MMR. [`mmr_select`] is provided as a tested primitive for callers
//! that have embeddings and want diversity, and is deliberately described that
//! way rather than as part of the packing path — claiming MMR while running a
//! greedy pass is the exact defect this module replaced.
//!
//! Faithful Rust port of `src/lib/resume-synthesis/selection.ts`.
//!
//! The MCP tool this replaces advertised "knapsack optimization and MMR
//! diversity" in its own tool description while implementing a greedy first-fit
//! over a sorted list, with a line model that charged one line per bullet
//! regardless of length (so a 300-character bullet and a 20-character bullet
//! cost the same) and no section caps, no per-org de-duplication, and no
//! must-have coverage repair.

use crate::career_db::ExperienceBlock;
use std::collections::{HashMap, HashSet};

use super::scoring::ScoredBlock;
use super::text::text_covers_skill;
use crate::semantic_layer::math::cosine_similarity;

/// Approximate printable characters per rendered resume line.
pub const CHARS_PER_LINE: usize = 95;

/// Fixed overhead reserved before packing: header + summary + skills + ~3
/// section titles.
pub const BUDGET_FIXED_OVERHEAD_LINES: usize = 4 + 3 + 2 + 3;

/// Default max bullets kept per selected block after the relevance trim.
pub const DEFAULT_MAX_BULLETS_PER_BLOCK: usize = 4;

/// Score gap a challenger must beat to displace another entry from the same org.
pub const DEFAULT_ORG_SCORE_GAP: f64 = 0.12;

/// Default per-section cap when the budget does not name one.
pub const DEFAULT_SECTION_CAP: usize = 3;

#[derive(Debug, Clone)]
pub struct SelectionBudget {
    pub total_lines: usize,
    pub per_bullet: usize,
    pub blocks_per_section: HashMap<String, usize>,
}

impl SelectionBudget {
    /// A one- or two-page budget.
    ///
    /// Page capacity is derived from the same line model the packer uses, so
    /// `total_lines` and the cost function cannot drift apart.
    /// Max bullets to keep per selected block for this budget.
    pub fn bullets_per_block(&self) -> usize {
        self.per_bullet.max(1)
    }

    pub fn for_pages(pages: usize) -> Self {
        // ~48 body lines per page at 10pt with 0.5in margins.
        const LINES_PER_PAGE: usize = 48;
        let pages = pages.clamp(1, 4);
        let total = pages * LINES_PER_PAGE;
        Self {
            total_lines: total.saturating_sub(BUDGET_FIXED_OVERHEAD_LINES),
            per_bullet: DEFAULT_MAX_BULLETS_PER_BLOCK,
            blocks_per_section: HashMap::new(),
        }
    }

    fn section_cap(&self, section: &str) -> usize {
        self.blocks_per_section.get(section).copied().unwrap_or(DEFAULT_SECTION_CAP)
    }
}

/// Map a block kind to its resume section. Port of `KIND_TO_SECTION`.
pub fn section_for_block(block: &ExperienceBlock) -> String {
    match block.kind.as_str() {
        "experience" | "work" => "experience",
        "project" => "projects",
        "education" => "education",
        "skill_group" => "skills",
        "leadership" => "leadership",
        _ => "experience",
    }
    .to_string()
}

/// Estimate wrapped lines for a single bullet from its character length.
pub fn estimate_bullet_lines(text: &str, chars_per_line: usize) -> usize {
    let len = text.trim().chars().count();
    if len == 0 {
        return 1;
    }
    let width = chars_per_line.max(40);
    len.div_ceil(width).max(1)
}

/// Estimate a block's line cost: ~2 header lines plus wrapped bullet lines.
///
/// Only the first `max_bullets` bullets are charged, because that is all the
/// renderer prints (`trim_selected_bullets`). Charging for every bullet made a
/// long block look unaffordable and dropped qualifying roles while leaving the
/// page two-thirds empty.
pub fn estimate_block_lines_capped(
    block: &ExperienceBlock,
    chars_per_line: usize,
    max_bullets: usize,
) -> usize {
    let mut costs: Vec<usize> = block
        .bullets
        .iter()
        .map(|b| estimate_bullet_lines(&b.canonical, chars_per_line))
        .collect();
    // The trim keeps the most JD-relevant bullets, which are not knowable here,
    // so charge the most expensive survivors: an upper bound that can never
    // under-budget the rendered page.
    costs.sort_unstable_by(|a, b| b.cmp(a));
    let bullet_lines: usize = costs.into_iter().take(max_bullets.max(1)).sum();
    2 + bullet_lines.max(1)
}

/// Line cost using the default bullet cap.
pub fn estimate_block_lines(block: &ExperienceBlock, chars_per_line: usize) -> usize {
    estimate_block_lines_capped(block, chars_per_line, DEFAULT_MAX_BULLETS_PER_BLOCK)
}

/// True when a block shows evidence of a skill in tags, domains, or bullets.
pub fn covers_skill(block: &ExperienceBlock, skill: &str) -> bool {
    if skill.trim().is_empty() {
        return false;
    }
    if block.skills.iter().any(|s| super::text::skills_match(&s.name, skill)) {
        return true;
    }
    if block
        .domains
        .iter()
        .any(|d| super::text::skills_match(d, skill) || text_covers_skill(d, skill))
    {
        return true;
    }
    block.bullets.iter().any(|b| text_covers_skill(&b.canonical, skill))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSwap {
    pub dropped_id: String,
    pub added_id: String,
    pub skill: String,
}

pub struct SelectionResult {
    pub selected: Vec<ScoredBlock>,
    /// Must-have skills still uncovered after selection.
    pub uncovered_must_haves: Vec<String>,
    pub swaps: Vec<SelectionSwap>,
    pub estimated_lines: usize,
}

/// Greedy knapsack under a line budget, with section caps and per-org
/// de-duplication, then a must-have coverage repair pass.
pub fn knapsack_select(
    scored: &[ScoredBlock],
    budget: &SelectionBudget,
    must_have_skills: &[String],
    org_score_gap: f64,
) -> SelectionResult {
    let mut sorted: Vec<ScoredBlock> = scored.to_vec();
    sorted.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.block.id.cmp(&b.block.id))
    });

    let mut selected: Vec<ScoredBlock> = Vec::new();
    let mut by_org: HashMap<String, String> = HashMap::new();
    let mut section_counts: HashMap<String, usize> = HashMap::new();
    let mut lines = 0usize;

    for item in &sorted {
        let section = section_for_block(&item.block);
        let cap = budget.section_cap(&section);
        let count = section_counts.get(&section).copied().unwrap_or(0);
        if count >= cap {
            continue;
        }

        let cost = estimate_block_lines(&item.block, CHARS_PER_LINE);
        if lines + cost > budget.total_lines && !selected.is_empty() {
            continue;
        }

        let org_key = {
            let k = item.block.org.trim().to_lowercase();
            if k.is_empty() { item.block.id.clone() } else { k }
        };

        if let Some(incumbent_id) = by_org.get(&org_key).cloned() {
            let Some(incumbent) = selected.iter().find(|s| s.block.id == incumbent_id).cloned()
            else {
                continue;
            };
            if item.score < incumbent.score + org_score_gap {
                continue;
            }
            if let Some(idx) = selected.iter().position(|s| s.block.id == incumbent_id) {
                let prev_section = section_for_block(&incumbent.block);
                let e = section_counts.entry(prev_section).or_insert(1);
                *e = e.saturating_sub(1);
                lines = lines.saturating_sub(estimate_block_lines(&incumbent.block, CHARS_PER_LINE));
                selected.remove(idx);
            }
        }

        selected.push(item.clone());
        by_org.insert(org_key, item.block.id.clone());
        *section_counts.entry(section).or_insert(0) += 1;
        lines += cost;
    }

    // Coverage repair: try to swap in a block that covers an uncovered
    // must-have, sacrificing the lowest-scoring selected block that covers
    // nothing still-uncovered.
    let mut swaps: Vec<SelectionSwap> = Vec::new();
    let selected_ids: HashSet<String> = selected.iter().map(|s| s.block.id.clone()).collect();

    for skill in must_have_skills {
        if selected.iter().any(|s| covers_skill(&s.block, skill)) {
            continue;
        }
        let Some(candidate) = sorted
            .iter()
            .find(|c| !selected_ids.contains(&c.block.id) && covers_skill(&c.block, skill))
        else {
            continue;
        };
        let cand_cost = estimate_block_lines(&candidate.block, CHARS_PER_LINE);
        let cand_section = section_for_block(&candidate.block);

        // The repair pass may not undo what the main loop guarantees: a fresh
        // selection must never violate its own budget, section caps included.
        // A skill that cannot be covered within the caps stays in
        // `uncovered_must_haves` instead of silently overflowing the page.
        let section_has_room = |counts: &HashMap<String, usize>, section: &str| {
            counts.get(section).copied().unwrap_or(0) < budget.section_cap(section)
        };

        if lines + cand_cost <= budget.total_lines
            && section_has_room(&section_counts, &cand_section)
        {
            selected.push(candidate.clone());
            lines += cand_cost;
            *section_counts.entry(cand_section).or_insert(0) += 1;
            swaps.push(SelectionSwap {
                dropped_id: String::new(),
                added_id: candidate.block.id.clone(),
                skill: skill.clone(),
            });
            continue;
        }

        // Need room: drop the weakest block that is not the sole cover for any
        // other must-have.
        let victim = selected
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                !must_have_skills.iter().any(|m| {
                    covers_skill(&s.block, m)
                        && selected.iter().filter(|o| covers_skill(&o.block, m)).count() == 1
                })
            })
            .min_by(|a, b| {
                a.1.score.partial_cmp(&b.1.score).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(i, s)| (i, s.clone()));

        let Some((idx, weakest)) = victim else { continue };
        if weakest.score >= candidate.score {
            continue;
        }
        // Dropping the victim may still not free enough room. Committing the
        // swap regardless would push the resume past its page budget, which is
        // the one invariant selection exists to hold.
        let freed = estimate_block_lines(&weakest.block, CHARS_PER_LINE);
        if lines.saturating_sub(freed) + cand_cost > budget.total_lines {
            continue;
        }
        // The candidate's section needs headroom *after* the victim leaves it
        // (they are usually different sections).
        let victim_section = section_for_block(&weakest.block);
        let mut projected = section_counts.clone();
        let freed_slot = projected.entry(victim_section).or_insert(1);
        *freed_slot = freed_slot.saturating_sub(1);
        if !section_has_room(&projected, &cand_section) {
            continue;
        }
        lines = lines.saturating_sub(freed);
        selected.remove(idx);
        selected.push(candidate.clone());
        lines += cand_cost;
        section_counts = projected;
        swaps.push(SelectionSwap {
            dropped_id: weakest.block.id.clone(),
            added_id: candidate.block.id.clone(),
            skill: skill.clone(),
        });
    }

    let uncovered_must_haves: Vec<String> = must_have_skills
        .iter()
        .filter(|m| !selected.iter().any(|s| covers_skill(&s.block, m)))
        .cloned()
        .collect();

    selected.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.block.id.cmp(&b.block.id))
    });

    SelectionResult { selected, uncovered_must_haves, swaps, estimated_lines: lines }
}

/// Keep at most `max_bullets` bullets per block, ranked by how many must-have
/// skills each bullet evidences, then by original order.
pub fn trim_selected_bullets(
    block: &ExperienceBlock,
    must_have_skills: &[String],
    max_bullets: usize,
) -> Vec<String> {
    if block.bullets.len() <= max_bullets {
        return block.bullets.iter().map(|b| b.id.clone()).collect();
    }
    let mut ranked: Vec<(usize, usize, &str)> = block
        .bullets
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let hits = must_have_skills
                .iter()
                .filter(|s| text_covers_skill(&b.canonical, s))
                .count();
            (hits, i, b.id.as_str())
        })
        .collect();
    // Higher hit count first; original order breaks ties.
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut kept: Vec<(usize, String)> = ranked
        .into_iter()
        .take(max_bullets)
        .map(|(_, i, id)| (i, id.to_string()))
        .collect();
    // Restore document order among the survivors.
    kept.sort_by_key(|(i, _)| *i);
    kept.into_iter().map(|(_, id)| id).collect()
}

/// Budget/cap violations in an already-made selection, for callers that report
/// what a selection cost rather than recomputing it.
///
/// Returns human-readable strings in a deterministic order so the message is
/// stable across runs (`HashMap` iteration order is not).
pub fn budget_violations(selected: &[ScoredBlock], budget: &SelectionBudget) -> Vec<String> {
    let mut violations = Vec::new();
    let mut section_counts: HashMap<String, usize> = HashMap::new();
    let mut lines = 0usize;
    for s in selected {
        *section_counts.entry(section_for_block(&s.block)).or_insert(0) += 1;
        lines += estimate_block_lines(&s.block, CHARS_PER_LINE);
    }
    let mut sections: Vec<(&String, &usize)> = section_counts.iter().collect();
    sections.sort_by_key(|(k, _)| (*k).clone());
    for (section, count) in sections {
        let cap = budget.section_cap(section);
        if *count > cap {
            violations.push(format!("{section}: {count} blocks exceeds cap {cap}"));
        }
    }
    if lines > budget.total_lines && !selected.is_empty() {
        let min_cost = selected
            .iter()
            .map(|s| estimate_block_lines(&s.block, CHARS_PER_LINE))
            .min()
            .unwrap_or(0);
        // A single block that alone exceeds the budget is allowed to overflow;
        // `knapsack_select` admits it deliberately rather than emitting nothing.
        if !(selected.len() == 1 && min_cost > budget.total_lines) {
            violations.push(format!(
                "totalLines {lines} exceeds budget {}",
                budget.total_lines
            ));
        }
    }
    violations
}

/// One candidate for [`mmr_select`]: the item, its relevance, and the embedding
/// diversity is measured over.
pub struct MmrCandidate<T> {
    pub item: T,
    pub relevance: f64,
    pub vec: Vec<f32>,
}

/// Maximal Marginal Relevance: `lambda` toward 1 favours relevance, toward 0
/// favours diversity.
///
/// Similarity goes through [`crate::semantic_layer::math::cosine_similarity`],
/// the canonical owner already used by `career_db::vectors`, rather than a
/// second local copy.
pub fn mmr_select<T: Clone>(candidates: &[MmrCandidate<T>], k: usize, lambda: f64) -> Vec<T> {
    if k == 0 || candidates.is_empty() {
        return Vec::new();
    }
    let mut remaining: Vec<usize> = (0..candidates.len()).collect();
    let mut chosen: Vec<usize> = Vec::new();

    while chosen.len() < k && !remaining.is_empty() {
        let mut best_pos = 0usize;
        let mut best_score = f64::NEG_INFINITY;
        for (pos, &idx) in remaining.iter().enumerate() {
            let c = &candidates[idx];
            let mut max_sim = 0.0f64;
            for &s in &chosen {
                let sim = cosine_similarity(&c.vec, &candidates[s].vec) as f64;
                if sim > max_sim {
                    max_sim = sim;
                }
            }
            let mmr = lambda * c.relevance - (1.0 - lambda) * max_sim;
            if mmr > best_score {
                best_score = mmr;
                best_pos = pos;
            }
        }
        chosen.push(remaining.remove(best_pos));
    }

    chosen
        .into_iter()
        .map(|i| candidates[i].item.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::career_db::{Bullet, DateRange, ExperienceBlock, SkillTag};
    use crate::career_match::scoring::ScoreComponents;

    fn bullet(id: &str, text: &str) -> Bullet {
        Bullet {
            id: id.to_string(),
            canonical: text.to_string(),
            variants: serde_json::Map::new(),
            metrics: vec![],
            evidence_refs: vec![],
            locked: false,
        }
    }

    fn scored(id: &str, org: &str, score: f64, bullets: Vec<Bullet>, skills: &[&str]) -> ScoredBlock {
        ScoredBlock {
            block: ExperienceBlock {
                id: id.to_string(),
                kind: "experience".into(),
                title: "T".into(),
                org: org.to_string(),
                date_range: DateRange { start: "2023-01".into(), end: None },
                personas: vec![],
                domains: vec![],
                skills: skills
                    .iter()
                    .map(|s| SkillTag { name: s.to_string(), level: 3, years: None })
                    .collect(),
                seniority_level: "senior".into(),
                location: None,
                url: None,
                url_label: None,
                extra: None,
                bullets,
                facts: vec![],
                notes: None,
                embedding_text: None,
                updated_at: "0".into(),
            },
            components: ScoreComponents::default(),
            score,
        }
    }

    #[test]
    fn long_bullets_cost_more_lines_than_short_ones() {
        let short = bullet("s", "Short bullet.");
        let long = bullet("l", &"x".repeat(CHARS_PER_LINE * 3));
        assert_eq!(estimate_bullet_lines(&short.canonical, CHARS_PER_LINE), 1);
        assert_eq!(estimate_bullet_lines(&long.canonical, CHARS_PER_LINE), 3);
        // Empty text still occupies a line.
        assert_eq!(estimate_bullet_lines("", CHARS_PER_LINE), 1);
        assert_eq!(estimate_bullet_lines("   ", CHARS_PER_LINE), 1);
    }

    #[test]
    fn block_cost_includes_header_lines() {
        let b = scored("a", "Org", 1.0, vec![bullet("x", "one line")], &[]);
        assert_eq!(estimate_block_lines(&b.block, CHARS_PER_LINE), 3);
        let empty = scored("b", "Org", 1.0, vec![], &[]);
        assert_eq!(estimate_block_lines(&empty.block, CHARS_PER_LINE), 3);
    }

    #[test]
    fn selection_respects_the_line_budget() {
        let blocks: Vec<ScoredBlock> = (0..40)
            .map(|i| {
                scored(
                    &format!("b{i:02}"),
                    &format!("org{i}"),
                    1.0 - (i as f64) * 0.01,
                    vec![bullet("x", &"y".repeat(200))],
                    &[],
                )
            })
            .collect();
        let mut budget = SelectionBudget::for_pages(1);
        budget.blocks_per_section.insert("experience".into(), 99);
        let r = knapsack_select(&blocks, &budget, &[], DEFAULT_ORG_SCORE_GAP);
        assert!(
            r.estimated_lines <= budget.total_lines,
            "over budget: {} > {}",
            r.estimated_lines,
            budget.total_lines
        );
        assert!(!r.selected.is_empty());
    }

    #[test]
    fn a_two_page_budget_admits_more_than_one_page() {
        let blocks: Vec<ScoredBlock> = (0..40)
            .map(|i| {
                scored(
                    &format!("b{i:02}"),
                    &format!("org{i}"),
                    1.0 - (i as f64) * 0.01,
                    vec![bullet("x", &"y".repeat(200))],
                    &[],
                )
            })
            .collect();
        let mut one = SelectionBudget::for_pages(1);
        one.blocks_per_section.insert("experience".into(), 99);
        let mut two = SelectionBudget::for_pages(2);
        two.blocks_per_section.insert("experience".into(), 99);
        let r1 = knapsack_select(&blocks, &one, &[], DEFAULT_ORG_SCORE_GAP);
        let r2 = knapsack_select(&blocks, &two, &[], DEFAULT_ORG_SCORE_GAP);
        assert!(r2.selected.len() > r1.selected.len());
    }

    #[test]
    fn section_caps_are_enforced() {
        let blocks: Vec<ScoredBlock> = (0..10)
            .map(|i| scored(&format!("b{i}"), &format!("org{i}"), 0.9, vec![], &[]))
            .collect();
        let mut budget = SelectionBudget::for_pages(2);
        budget.blocks_per_section.insert("experience".into(), 3);
        let r = knapsack_select(&blocks, &budget, &[], DEFAULT_ORG_SCORE_GAP);
        assert_eq!(r.selected.len(), 3);
    }

    #[test]
    fn same_org_entries_are_deduplicated_unless_clearly_better() {
        let blocks = vec![
            scored("low", "Acme", 0.50, vec![], &[]),
            scored("mid", "Acme", 0.55, vec![], &[]),   // within the 0.12 gap
            scored("high", "Acme", 0.90, vec![], &[]),  // clears the gap
        ];
        let budget = SelectionBudget::for_pages(2);
        let r = knapsack_select(&blocks, &budget, &[], DEFAULT_ORG_SCORE_GAP);
        assert_eq!(r.selected.len(), 1, "got {:?}", r.selected.iter().map(|s| &s.block.id).collect::<Vec<_>>());
        assert_eq!(r.selected[0].block.id, "high");
    }

    #[test]
    fn coverage_repair_pulls_in_a_block_for_an_uncovered_must_have() {
        // Same org, so the main loop's de-duplication skips the Rust block and
        // the repair pass must pull it in. The budget keeps its default caps:
        // a repair that only worked by pushing a section past its cap was the
        // defect `coverage_repair_respects_section_caps` pins.
        let budget = SelectionBudget::for_pages(1);
        let blocks = vec![
            scored("top", "A", 0.99, vec![bullet("x", "generic work")], &["Excel"]),
            scored("rust", "A", 0.10, vec![bullet("y", "wrote Rust systems")], &["Rust"]),
        ];
        let r = knapsack_select(&blocks, &budget, &["rust".into()], DEFAULT_ORG_SCORE_GAP);
        assert!(
            r.selected.iter().any(|s| s.block.id == "rust"),
            "coverage repair did not run: {:?}",
            r.selected.iter().map(|s| &s.block.id).collect::<Vec<_>>()
        );
        assert!(r.uncovered_must_haves.is_empty());
        assert!(!r.swaps.is_empty());
        assert!(budget_violations(&r.selected, &budget).is_empty());
    }

    /// Coverage repair may add or swap in a must-have cover, but it may not
    /// push a section past its cap: the main loop enforces caps, and
    /// `budget_violations` — the engine's own auditor — would reject any
    /// selection that ignored them. Found by `career_match::stress` (seed 169).
    #[test]
    fn coverage_repair_respects_section_caps() {
        let budget = SelectionBudget::for_pages(1);
        let blocks = vec![
            scored("a", "org-a", 0.90, vec![bullet("x", "wrote Rust services")], &["Rust"]),
            scored("b", "org-b", 0.89, vec![bullet("y", "more Rust work")], &["Rust"]),
            scored("c", "org-c", 0.88, vec![bullet("z", "yet more Rust")], &["Rust"]),
            scored("d", "org-d", 0.40, vec![bullet("w", "runs Kubernetes fleets")], &["Kubernetes"]),
        ];
        let must = vec!["rust".into(), "kubernetes".into()];
        let r = knapsack_select(&blocks, &budget, &must, DEFAULT_ORG_SCORE_GAP);

        // Pre-fix this selected all four experience blocks: the repair pass
        // added "d" for kubernetes with no cap check.
        assert!(
            budget_violations(&r.selected, &budget).is_empty(),
            "a fresh selection violates its own budget: {:?}",
            budget_violations(&r.selected, &budget)
        );
        assert_eq!(r.selected.len(), 3);
        // The skill that cannot be covered within the caps is reported, not
        // silently smuggled onto the page.
        assert_eq!(r.uncovered_must_haves, vec!["kubernetes".to_string()]);
    }

    #[test]
    fn uncovered_must_haves_are_reported_not_hidden() {
        let budget = SelectionBudget::for_pages(1);
        let blocks = vec![scored("a", "A", 0.9, vec![bullet("x", "generic")], &["Excel"])];
        let r = knapsack_select(&blocks, &budget, &["fortran".into()], DEFAULT_ORG_SCORE_GAP);
        assert_eq!(r.uncovered_must_haves, vec!["fortran".to_string()]);
    }

    #[test]
    fn empty_input_selects_nothing_without_panicking() {
        let budget = SelectionBudget::for_pages(1);
        let r = knapsack_select(&[], &budget, &["rust".into()], DEFAULT_ORG_SCORE_GAP);
        assert!(r.selected.is_empty());
        assert_eq!(r.uncovered_must_haves, vec!["rust".to_string()]);
    }

    #[test]
    fn one_oversized_block_is_still_selected() {
        // The first item is admitted even when it alone exceeds the budget,
        // otherwise a single long role would yield an empty resume.
        let budget = SelectionBudget::for_pages(1);
        let huge = scored("h", "A", 0.9, vec![bullet("x", &"z".repeat(100_000))], &[]);
        let r = knapsack_select(&[huge], &budget, &[], DEFAULT_ORG_SCORE_GAP);
        assert_eq!(r.selected.len(), 1);
    }

    #[test]
    fn selection_is_deterministic_across_input_orderings() {
        let mut a = vec![
            scored("x", "OrgX", 0.5, vec![], &[]),
            scored("y", "OrgY", 0.5, vec![], &[]),
            scored("z", "OrgZ", 0.5, vec![], &[]),
        ];
        let budget = SelectionBudget::for_pages(2);
        let r1 = knapsack_select(&a, &budget, &[], DEFAULT_ORG_SCORE_GAP);
        a.reverse();
        let r2 = knapsack_select(&a, &budget, &[], DEFAULT_ORG_SCORE_GAP);
        let ids1: Vec<_> = r1.selected.iter().map(|s| s.block.id.clone()).collect();
        let ids2: Vec<_> = r2.selected.iter().map(|s| s.block.id.clone()).collect();
        assert_eq!(ids1, ids2, "tie-break is not order-independent");
    }





    #[test]
    fn bullet_trim_keeps_the_most_relevant_in_document_order() {
        let b = scored(
            "a",
            "Org",
            0.9,
            vec![
                bullet("b1", "generic filler"),
                bullet("b2", "shipped Rust services"),
                bullet("b3", "more filler"),
                bullet("b4", "deep Kubernetes work"),
                bullet("b5", "even more filler"),
            ],
            &[],
        );
        let kept = trim_selected_bullets(&b.block, &["rust".into(), "kubernetes".into()], 2);
        assert_eq!(kept, vec!["b2".to_string(), "b4".to_string()]);
    }

    #[test]
    fn bullet_trim_is_a_noop_below_the_cap() {
        let b = scored("a", "Org", 0.9, vec![bullet("b1", "x"), bullet("b2", "y")], &[]);
        assert_eq!(trim_selected_bullets(&b.block, &[], 4), vec!["b1", "b2"]);
    }

    /// Regression: the coverage-repair pass used to commit a swap even when the
    /// freed space was smaller than the incoming block.
    #[test]
    fn coverage_repair_never_overruns_the_line_budget() {
        let mut budget = SelectionBudget::for_pages(1);
        budget.blocks_per_section.insert("experience".into(), 99);
        // One tiny incumbent, one enormous block that covers the must-have.
        let blocks = vec![
            scored("small", "A", 0.99, vec![bullet("x", "tiny")], &["Excel"]),
            scored(
                "huge",
                "B",
                0.10,
                vec![bullet("y", &format!("Rust {}", "z".repeat(20_000)))],
                &["Rust"],
            ),
        ];
        let r = knapsack_select(&blocks, &budget, &["rust".into()], DEFAULT_ORG_SCORE_GAP);
        assert!(
            r.estimated_lines <= budget.total_lines,
            "coverage repair overran budget: {} > {}",
            r.estimated_lines,
            budget.total_lines
        );
    }

    #[test]
    fn coverage_repair_reports_what_it_could_not_cover() {
        let mut budget = SelectionBudget::for_pages(1);
        budget.blocks_per_section.insert("experience".into(), 99);
        let blocks = vec![
            scored("small", "A", 0.99, vec![bullet("x", "tiny")], &["Excel"]),
            scored(
                "huge",
                "B",
                0.10,
                vec![bullet("y", &format!("Rust {}", "z".repeat(20_000)))],
                &["Rust"],
            ),
        ];
        let r = knapsack_select(&blocks, &budget, &["rust".into()], DEFAULT_ORG_SCORE_GAP);
        if !r.selected.iter().any(|s| covers_skill(&s.block, "rust")) {
            assert_eq!(r.uncovered_must_haves, vec!["rust".to_string()]);
        }
    }

    /// Regression: the budget charged for bullets the renderer trims away.
    #[test]
    fn line_cost_charges_only_the_bullets_that_will_be_printed() {
        let many: Vec<Bullet> = (0..20)
            .map(|i| bullet(&format!("b{i}"), &"x".repeat(90)))
            .collect();
        let b = scored("a", "Org", 0.9, many, &[]);
        // 2 header lines + 4 charged bullets, not 20.
        assert_eq!(
            estimate_block_lines(&b.block, CHARS_PER_LINE),
            2 + DEFAULT_MAX_BULLETS_PER_BLOCK
        );
    }

    #[test]
    fn capped_cost_is_an_upper_bound_on_any_trim() {
        let mixed = vec![
            bullet("a", &"x".repeat(300)),
            bullet("b", "short"),
            bullet("c", &"y".repeat(200)),
            bullet("d", "tiny"),
            bullet("e", &"z".repeat(400)),
        ];
        let blk = scored("a", "Org", 0.9, mixed, &[]);
        let capped = estimate_block_lines_capped(&blk.block, CHARS_PER_LINE, 3);
        // Whichever 3 the trim keeps, they cannot cost more than the 3 priciest.
        let mut costs: Vec<usize> = blk
            .block
            .bullets
            .iter()
            .map(|b| estimate_bullet_lines(&b.canonical, CHARS_PER_LINE))
            .collect();
        costs.sort_unstable_by(|a, b| b.cmp(a));
        assert_eq!(capped, 2 + costs.iter().take(3).sum::<usize>());
    }

    #[test]
    fn a_long_role_is_no_longer_unaffordable() {
        let mut budget = SelectionBudget::for_pages(1);
        budget.blocks_per_section.insert("experience".into(), 99);
        let long_role = scored(
            "long",
            "Acme",
            0.9,
            (0..30).map(|i| bullet(&format!("b{i}"), &"x".repeat(90))).collect(),
            &["Rust"],
        );
        let r = knapsack_select(&[long_role], &budget, &["rust".into()], DEFAULT_ORG_SCORE_GAP);
        assert_eq!(r.selected.len(), 1);
        assert!(r.estimated_lines <= budget.total_lines);
    }

    #[test]
    fn budget_violations_is_silent_on_a_selection_that_fits() {
        let b = SelectionBudget::for_pages(2);
        let sel = vec![
            scored("a", "OrgA", 0.9, vec![bullet("b1", "Short.")], &[]),
            scored("b", "OrgB", 0.8, vec![bullet("b2", "Also short.")], &[]),
        ];
        assert!(budget_violations(&sel, &b).is_empty());
        // And an empty selection cannot violate anything.
        assert!(budget_violations(&[], &b).is_empty());
    }

    #[test]
    fn budget_violations_flags_an_over_capped_section() {
        let b = SelectionBudget::for_pages(4);
        // DEFAULT_SECTION_CAP is 3; five "experience" blocks exceed it.
        let sel: Vec<ScoredBlock> = (0..5)
            .map(|i| {
                scored(
                    &format!("blk{i}"),
                    &format!("Org{i}"),
                    0.5,
                    vec![bullet("b", "Short.")],
                    &[],
                )
            })
            .collect();
        let v = budget_violations(&sel, &b);
        assert!(
            v.iter().any(|m| m.contains("experience") && m.contains("cap")),
            "expected a section-cap violation, got {v:?}"
        );
    }

    #[test]
    fn budget_violations_flags_an_overrun_but_spares_one_oversized_block() {
        let b = SelectionBudget::for_pages(1);
        let huge = || bullet("b", &"x".repeat(CHARS_PER_LINE * 40));

        // A single block that alone cannot fit is admitted deliberately by
        // `knapsack_select`, so reporting it as a violation would be noise.
        let one = vec![scored("solo", "OrgA", 0.9, vec![huge()], &[])];
        assert!(
            !budget_violations(&one, &b).iter().any(|m| m.contains("totalLines")),
            "a lone oversized block must not be reported as an overrun"
        );

        // Two of them is a genuine overrun.
        let two = vec![
            scored("a", "OrgA", 0.9, vec![huge()], &[]),
            scored("b", "OrgB", 0.8, vec![huge()], &[]),
        ];
        assert!(
            budget_violations(&two, &b).iter().any(|m| m.contains("totalLines")),
            "an overrun across several blocks must be reported"
        );
    }

    #[test]
    fn mmr_at_lambda_one_is_pure_relevance() {
        let cands = vec![
            MmrCandidate { item: "low", relevance: 0.1, vec: vec![1.0, 0.0] },
            MmrCandidate { item: "high", relevance: 0.9, vec: vec![1.0, 0.0] },
            MmrCandidate { item: "mid", relevance: 0.5, vec: vec![0.0, 1.0] },
        ];
        assert_eq!(mmr_select(&cands, 3, 1.0), vec!["high", "mid", "low"]);
    }

    #[test]
    fn mmr_below_one_prefers_a_dissimilar_second_pick() {
        // "near" is more relevant than "far" but is a duplicate of "top".
        let cands = vec![
            MmrCandidate { item: "top", relevance: 0.90, vec: vec![1.0, 0.0] },
            MmrCandidate { item: "near", relevance: 0.80, vec: vec![1.0, 0.0] },
            MmrCandidate { item: "far", relevance: 0.70, vec: vec![0.0, 1.0] },
        ];
        assert_eq!(
            mmr_select(&cands, 2, 1.0),
            vec!["top", "near"],
            "pure relevance takes the near-duplicate"
        );
        assert_eq!(
            mmr_select(&cands, 2, 0.5),
            vec!["top", "far"],
            "diversity must break the near-duplicate tie"
        );
    }

    #[test]
    fn mmr_handles_degenerate_requests() {
        let cands = vec![MmrCandidate { item: "a", relevance: 0.5, vec: vec![1.0] }];
        assert!(mmr_select(&cands, 0, 0.7).is_empty());
        assert_eq!(mmr_select(&cands, 99, 0.7), vec!["a"], "k above len yields all");
        let empty: Vec<MmrCandidate<&str>> = Vec::new();
        assert!(mmr_select(&empty, 3, 0.7).is_empty());
        // A zero vector cannot produce a NaN similarity and stall the loop.
        let zeros = vec![
            MmrCandidate { item: "z1", relevance: 0.5, vec: vec![0.0, 0.0] },
            MmrCandidate { item: "z2", relevance: 0.4, vec: vec![0.0, 0.0] },
        ];
        assert_eq!(mmr_select(&zeros, 2, 0.5).len(), 2);
    }
}
