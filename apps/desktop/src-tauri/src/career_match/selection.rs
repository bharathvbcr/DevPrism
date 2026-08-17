//! Faithful port of `src/lib/resume-synthesis/selection.ts`.
//!
//! Greedy knapsack under a template line budget with per-section caps and a
//! one-block-per-org rule, then must-have coverage swaps that are reverted if
//! they uncover a skill that was already covered. Plus bullet-level trim, and
//! the cosine/MMR helpers used for evidence diversity.

use std::collections::{HashMap, HashSet};

use crate::career_db::{Bullet, ExperienceBlock};

use super::scoring::{skill_overlap, skills_match, sort_scored, text_covers_skill, ScoredBlock};

/// Default max bullets kept per selected block after relevance trim.
pub const DEFAULT_MAX_BULLETS_PER_BLOCK: usize = 4;

/// Approximate printable characters per resume line (for wrap estimates).
pub const CHARS_PER_LINE: usize = 95;

/// Fixed overhead reserved before packing: header(4) + summary(3) + skills(2)
/// + ~3 section titles.
pub const BUDGET_FIXED_OVERHEAD_LINES: usize = 4 + 3 + 2 + 3;

/// Score a challenger must exceed an incumbent from the same org by.
pub const DEFAULT_ORG_SCORE_GAP: f64 = 0.12;

#[derive(Debug, Clone)]
pub struct SelectionBudget {
    pub total_lines: usize,
    pub per_bullet: usize,
    pub blocks_per_section: HashMap<String, usize>,
}

impl SelectionBudget {
    /// `budgetFromTemplate`: subtract fixed overhead, floor at 1 line.
    pub fn from_template(
        total_lines: usize,
        per_bullet: usize,
        blocks_per_section: HashMap<String, usize>,
    ) -> Self {
        Self {
            total_lines: total_lines.saturating_sub(BUDGET_FIXED_OVERHEAD_LINES).max(1),
            per_bullet,
            blocks_per_section,
        }
    }

    fn section_cap(&self, section: &str) -> usize {
        self.blocks_per_section.get(section).copied().unwrap_or(3)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapRecord {
    pub dropped_id: String,
    pub added_id: String,
    pub skill: String,
}

pub struct SelectionResult {
    pub selected: Vec<ScoredBlock>,
    /// Must-have skills still uncovered after selection.
    pub uncovered_must_haves: Vec<String>,
    pub swaps: Vec<SwapRecord>,
}

/// `sectionForBlock`: block kind → resume section.
pub fn section_for_block(block: &ExperienceBlock) -> &'static str {
    match block.kind.as_str() {
        "project" => "projects",
        "publication" => "publications",
        "education" => "education",
        "leadership" => "leadership",
        // TS: `KIND_TO_SECTION[kind] ?? "experience"`.
        _ => "experience",
    }
}

/// `estimateBulletLines`: wrapped lines for one bullet.
pub fn estimate_bullet_lines(text: &str, chars_per_line: usize) -> usize {
    let len = text.trim().chars().count();
    if len == 0 {
        return 1;
    }
    let width = chars_per_line.max(40);
    len.div_ceil(width).max(1)
}

/// `estimateBlockLines`: 2 header lines + wrapped bullet lines.
pub fn estimate_block_lines(block: &ExperienceBlock) -> usize {
    let bullet_lines: usize = block
        .bullets
        .iter()
        .map(|b| estimate_bullet_lines(&b.canonical, CHARS_PER_LINE))
        .sum();
    2 + bullet_lines.max(1)
}

/// `bulletCoversSkill`.
pub fn bullet_covers_skill(bullet: &Bullet, skill: &str, text_override: Option<&str>) -> bool {
    if skill.trim().is_empty() {
        return false;
    }
    text_covers_skill(text_override.unwrap_or(&bullet.canonical), skill)
}

/// `coversSkill`: skill appears in block tags, domains, or any bullet text.
pub fn covers_skill(block: &ExperienceBlock, skill: &str) -> bool {
    if skill.trim().is_empty() {
        return false;
    }
    let one = [skill.to_string()];
    if skill_overlap(&block.skills, &one, &[], None) > 0.0 {
        return true;
    }
    if block
        .domains
        .iter()
        .any(|d| skills_match(d, skill) || text_covers_skill(d, skill))
    {
        return true;
    }
    block.bullets.iter().any(|b| bullet_covers_skill(b, skill, None))
}

fn org_key(block: &ExperienceBlock) -> String {
    let t = block.org.trim().to_lowercase();
    if t.is_empty() { block.id.clone() } else { t }
}

/// Mutable packing state shared by the greedy pass and the swap pass.
struct PackState {
    selected: Vec<ScoredBlock>,
    by_org: HashMap<String, String>,
    section_counts: HashMap<String, usize>,
    lines: usize,
}

impl PackState {
    fn new() -> Self {
        Self {
            selected: Vec::new(),
            by_org: HashMap::new(),
            section_counts: HashMap::new(),
            lines: 0,
        }
    }

    fn snapshot(&self) -> (Vec<ScoredBlock>, HashMap<String, String>, HashMap<String, usize>, usize) {
        (
            self.selected.clone(),
            self.by_org.clone(),
            self.section_counts.clone(),
            self.lines,
        )
    }

    fn restore(
        &mut self,
        s: (Vec<ScoredBlock>, HashMap<String, String>, HashMap<String, usize>, usize),
    ) {
        self.selected = s.0;
        self.by_org = s.1;
        self.section_counts = s.2;
        self.lines = s.3;
    }

    fn remove_at(&mut self, idx: usize) -> ScoredBlock {
        let removed = self.selected.remove(idx);
        let section = section_for_block(&removed.block).to_string();
        let c = self.section_counts.entry(section).or_insert(1);
        *c = c.saturating_sub(1);
        self.lines = self.lines.saturating_sub(estimate_block_lines(&removed.block));
        removed
    }

    /// `tryAdd`: respects section cap, line budget, and the one-per-org rule.
    fn try_add(&mut self, item: &ScoredBlock, budget: &SelectionBudget, org_gap: f64) -> bool {
        let section = section_for_block(&item.block).to_string();
        let cap = budget.section_cap(&section);
        if self.section_counts.get(&section).copied().unwrap_or(0) >= cap {
            return false;
        }

        let cost = estimate_block_lines(&item.block);
        if self.lines + cost > budget.total_lines && !self.selected.is_empty() {
            return false;
        }

        let key = org_key(&item.block);
        if let Some(incumbent_id) = self.by_org.get(&key).cloned() {
            let incumbent_score = self
                .selected
                .iter()
                .find(|s| s.block.id == incumbent_id)
                .map(|s| s.score);
            let Some(incumbent_score) = incumbent_score else {
                // Stale org entry (incumbent already dropped) — clear and continue.
                self.by_org.remove(&key);
                return self.try_add(item, budget, org_gap);
            };
            if item.score < incumbent_score + org_gap {
                return false;
            }
            if let Some(idx) = self.selected.iter().position(|s| s.block.id == incumbent_id) {
                self.remove_at(idx);
            }
        }

        self.selected.push(item.clone());
        self.by_org.insert(key, item.block.id.clone());
        *self.section_counts.entry(section).or_insert(0) += 1;
        self.lines += cost;
        true
    }
}

fn covered_must_haves(selected: &[ScoredBlock], must_haves: &[String]) -> HashSet<String> {
    must_haves
        .iter()
        .filter(|skill| selected.iter().any(|s| covers_skill(&s.block, skill)))
        .cloned()
        .collect()
}

/// `knapsackSelect`.
pub fn knapsack_select(
    scored: &[ScoredBlock],
    budget: &SelectionBudget,
    must_have_skills: &[String],
    org_score_gap: Option<f64>,
) -> SelectionResult {
    let org_gap = org_score_gap.unwrap_or(DEFAULT_ORG_SCORE_GAP);

    let mut sorted = scored.to_vec();
    sort_scored(&mut sorted);

    let mut st = PackState::new();
    for item in &sorted {
        st.try_add(item, budget, org_gap);
    }

    let mut swaps: Vec<SwapRecord> = Vec::new();

    for skill in must_have_skills {
        if st.selected.iter().any(|s| covers_skill(&s.block, skill)) {
            continue;
        }

        let covered_before = covered_must_haves(&st.selected, must_have_skills);
        let snapshot = st.snapshot();

        let selected_ids: HashSet<&str> =
            st.selected.iter().map(|s| s.block.id.as_str()).collect();
        let Some(best) = sorted
            .iter()
            .find(|s| !selected_ids.contains(s.block.id.as_str()) && covers_skill(&s.block, skill))
            .cloned()
        else {
            continue;
        };

        // Prefer dropping the lowest-scoring selected block in the same
        // section, else the global lowest-scoring selected block.
        let section = section_for_block(&best.block);
        let same_section: Vec<ScoredBlock> = st
            .selected
            .iter()
            .filter(|s| section_for_block(&s.block) == section)
            .cloned()
            .collect();
        let pool = if same_section.is_empty() { st.selected.clone() } else { same_section };

        let mut swap_applied: Option<SwapRecord> = None;

        if pool.is_empty() {
            if st.try_add(&best, budget, org_gap) {
                swap_applied = Some(SwapRecord {
                    dropped_id: String::new(),
                    added_id: best.block.id.clone(),
                    skill: skill.clone(),
                });
            }
        } else {
            // `pool` is non-empty on this branch, but express that as control
            // flow rather than an `expect` — the crate denies `expect_used`.
            let Some(drop) = pool
                .iter()
                .min_by(|a, b| {
                    a.score
                        .partial_cmp(&b.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .cloned()
            else {
                continue;
            };

            if best.score + 0.05 < drop.score && covers_skill(&drop.block, skill) {
                continue;
            }
            let Some(drop_idx) = st.selected.iter().position(|s| s.block.id == drop.block.id)
            else {
                continue;
            };

            st.remove_at(drop_idx);
            st.by_org.remove(&org_key(&drop.block));

            if st.try_add(&best, budget, org_gap) {
                swap_applied = Some(SwapRecord {
                    dropped_id: drop.block.id.clone(),
                    added_id: best.block.id.clone(),
                    skill: skill.clone(),
                });
            } else {
                // Restore the block we removed speculatively.
                st.try_add(&drop, budget, org_gap);
            }
        }

        let Some(applied) = swap_applied else { continue };

        // Re-verify: no previously covered must-have may become uncovered.
        let uncovered_now: Vec<&String> = covered_before
            .iter()
            .filter(|s| !st.selected.iter().any(|x| covers_skill(&x.block, s)))
            .collect();
        if !uncovered_now.is_empty() {
            st.restore(snapshot);
            continue;
        }

        swaps.push(applied);
    }

    let uncovered_must_haves: Vec<String> = must_have_skills
        .iter()
        .filter(|skill| !st.selected.iter().any(|s| covers_skill(&s.block, skill)))
        .cloned()
        .collect();

    let mut selected = st.selected;
    sort_scored(&mut selected);

    SelectionResult {
        selected,
        uncovered_must_haves,
        swaps,
    }
}

/// `assertBudgetInvariants`: returns the list of violations (empty = ok).
pub fn budget_violations(selected: &[ScoredBlock], budget: &SelectionBudget) -> Vec<String> {
    let mut violations = Vec::new();
    let mut section_counts: HashMap<&str, usize> = HashMap::new();
    let mut lines = 0usize;
    for s in selected {
        *section_counts.entry(section_for_block(&s.block)).or_insert(0) += 1;
        lines += estimate_block_lines(&s.block);
    }
    // Deterministic order so the message is stable across runs.
    let mut sections: Vec<(&&str, &usize)> = section_counts.iter().collect();
    sections.sort_by_key(|(k, _)| **k);
    for (section, count) in sections {
        let cap = budget.section_cap(section);
        if *count > cap {
            violations.push(format!("{section}: {count} blocks exceeds cap {cap}"));
        }
    }
    if lines > budget.total_lines && !selected.is_empty() {
        let min_cost = selected
            .iter()
            .map(|s| estimate_block_lines(&s.block))
            .min()
            .unwrap_or(0);
        // A single block that alone exceeds the budget is allowed to overflow.
        if !(selected.len() == 1 && min_cost > budget.total_lines) {
            violations.push(format!(
                "totalLines {lines} exceeds budget {}",
                budget.total_lines
            ));
        }
    }
    violations
}

pub struct TrimOptions<'a> {
    pub max_bullets_per_block: usize,
    pub relevance_by_bullet_id: &'a HashMap<String, f64>,
    pub must_have_skills: &'a [String],
}

/// `trimSelectedBullets`: rank each block's bullets by embedding relevance plus
/// a must-have keyword boost, keep locked bullets always, trim to budget, and
/// preserve the original bullet order among those kept.
pub fn trim_selected_bullets(selected: &[ScoredBlock], opts: &TrimOptions) -> Vec<ScoredBlock> {
    let max_per = opts.max_bullets_per_block;
    selected
        .iter()
        .map(|item| {
            let bullets = &item.block.bullets;
            if bullets.len() <= max_per {
                return item.clone();
            }

            let locked: Vec<&Bullet> = bullets.iter().filter(|b| b.locked).collect();
            let unlocked: Vec<&Bullet> = bullets.iter().filter(|b| !b.locked).collect();

            let score_bullet = |b: &Bullet| -> f64 {
                let emb = opts.relevance_by_bullet_id.get(&b.id).copied().unwrap_or(0.0);
                let boost: f64 = opts
                    .must_have_skills
                    .iter()
                    .filter(|s| bullet_covers_skill(b, s, None))
                    .map(|_| 0.15)
                    .sum();
                (emb + boost).min(1.0)
            };

            let mut ranked = unlocked.clone();
            ranked.sort_by(|a, c| {
                score_bullet(c)
                    .partial_cmp(&score_bullet(a))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.id.cmp(&c.id))
            });

            let slots_left = max_per.saturating_sub(locked.len());
            let take = slots_left.max(if locked.is_empty() { 1 } else { 0 });
            let kept_unlocked = &ranked[..take.min(ranked.len())];

            let mut kept_ids: HashSet<&str> =
                locked.iter().map(|b| b.id.as_str()).collect();
            for b in kept_unlocked {
                kept_ids.insert(b.id.as_str());
            }
            if kept_ids.is_empty() {
                if let Some(first) = bullets.first() {
                    kept_ids.insert(first.id.as_str());
                }
            }

            let trimmed: Vec<Bullet> = bullets
                .iter()
                .filter(|b| kept_ids.contains(b.id.as_str()))
                .cloned()
                .collect();

            let mut out = item.clone();
            out.block.bullets = trimmed;
            out
        })
        .collect()
}

/// Cosine similarity; 0 on empty or length mismatch (matches TS).
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for i in 0..a.len() {
        let x = a[i] as f64;
        let y = b[i] as f64;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 {
        return 0.0;
    }
    dot / denom
}

pub struct MmrCandidate<T> {
    pub item: T,
    pub relevance: f64,
    pub vec: Vec<f32>,
}

/// Maximal Marginal Relevance: `lambda` toward 1 favors relevance, toward 0
/// favors diversity.
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
                let sim = cosine_similarity(&c.vec, &candidates[s].vec);
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

    chosen.into_iter().map(|i| candidates[i].item.clone()).collect()
}
