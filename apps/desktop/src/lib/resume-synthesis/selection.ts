/**
 * Stage 3 — Greedy knapsack under template budget + must-have coverage.
 * Also: bullet-level trim after block selection, and embedding MMR helpers.
 */

import type { Bullet, ExperienceBlock } from "@/lib/career/types";
import {
  BLOCK_KIND_TO_SECTION,
  canonicalizeBlockKind,
} from "@/lib/resume-sections";
import type {
  ResumeTemplateBudget,
  SectionKind,
} from "@/lib/resume-templates/types";
import type { ScoredBlock } from "./types";
import { skillOverlap, skillsMatch, textCoversSkill } from "./scoring";

export interface SelectionBudget {
  totalLines: number;
  perBullet: number;
  blocksPerSection: Partial<Record<SectionKind, number>>;
}

export interface SelectionResult {
  selected: ScoredBlock[];
  /** Skills from the JD must-have list still uncovered after selection. */
  uncoveredMustHaves: string[];
  swaps: Array<{ droppedId: string; addedId: string; skill: string }>;
}

/** Default max bullets kept per selected block after relevance trim. */
export const DEFAULT_MAX_BULLETS_PER_BLOCK = 4;

/** Approximate printable characters per resume line (for wrap estimates). */
export const CHARS_PER_LINE = 95;

/**
 * Fixed overhead lines reserved before knapsack packing
 * (header + summary + skills + a few section titles).
 */
export const BUDGET_FIXED_OVERHEAD_LINES = 4 + 3 + 2 + 3; // header, summary, skills, ~3 section titles

export function sectionForBlock(block: ExperienceBlock): SectionKind {
  const kind = canonicalizeBlockKind(block.kind) ?? "experience";
  return BLOCK_KIND_TO_SECTION[kind];
}

/** Estimate wrapped lines for a single bullet from its character length. */
export function estimateBulletLines(
  text: string,
  charsPerLine: number = CHARS_PER_LINE,
): number {
  const len = text.trim().length;
  if (len === 0) return 1;
  const width = Math.max(40, charsPerLine);
  return Math.max(1, Math.ceil(len / width));
}

/**
 * Estimate line cost: ~2 header lines + wrapped lines per bullet
 * (not 1 line per bullet).
 */
export function estimateBlockLines(
  block: ExperienceBlock,
  options?: { charsPerLine?: number; maxBullets?: number },
): number {
  const width = options?.charsPerLine ?? CHARS_PER_LINE;
  const maxBullets = options?.maxBullets ?? DEFAULT_MAX_BULLETS_PER_BLOCK;
  const costs = block.bullets.map((b) =>
    estimateBulletLines(b.canonical, width),
  );
  costs.sort((a, b) => b - a);
  const bulletLines = costs
    .slice(0, Math.max(1, maxBullets))
    .reduce((sum, n) => sum + n, 0);
  return 2 + Math.max(1, bulletLines || 1);
}

export function budgetFromTemplate(
  budget: ResumeTemplateBudget,
): SelectionBudget {
  return {
    totalLines: Math.max(1, budget.totalLines - BUDGET_FIXED_OVERHEAD_LINES),
    perBullet: budget.perBullet,
    blocksPerSection: { ...budget.blocksPerSection },
  };
}

/** True when skill appears in block tags, domains, or any bullet text. */
export function coversSkill(block: ExperienceBlock, skill: string): boolean {
  if (!skill.trim()) return false;
  if (skillOverlap(block.skills, [skill], [], undefined) > 0) return true;
  if (
    block.domains.some(
      (d) => skillsMatch(d, skill) || textCoversSkill(d, skill),
    )
  ) {
    return true;
  }
  return block.bullets.some((b) => bulletCoversSkill(b, skill));
}

/** True when a bullet's canonical (or provided) text mentions the skill. */
export function bulletCoversSkill(
  bullet: Bullet,
  skill: string,
  textOverride?: string,
): boolean {
  if (!skill.trim()) return false;
  return textCoversSkill(textOverride ?? bullet.canonical, skill);
}

function sectionCap(budget: SelectionBudget, section: SectionKind): number {
  return budget.blocksPerSection[section] ?? 3;
}

type SwapRecord = { droppedId: string; addedId: string; skill: string };

/**
 * Snapshot helpers so must-have swaps can be reverted when they uncover
 * a previously covered skill.
 */
function cloneSelectionState(selected: ScoredBlock[]): {
  selected: ScoredBlock[];
  byOrg: Map<string, ScoredBlock>;
  sectionCounts: Partial<Record<SectionKind, number>>;
  lines: number;
} {
  const byOrg = new Map<string, ScoredBlock>();
  const sectionCounts: Partial<Record<SectionKind, number>> = {};
  let lines = 0;
  for (const item of selected) {
    const orgKey = item.block.org.trim().toLowerCase() || item.block.id;
    byOrg.set(orgKey, item);
    const section = sectionForBlock(item.block);
    sectionCounts[section] = (sectionCounts[section] ?? 0) + 1;
    lines += estimateBlockLines(item.block);
  }
  return { selected: [...selected], byOrg, sectionCounts, lines };
}

function coveredMustHaves(
  selected: ScoredBlock[],
  mustHaveSkills: string[],
): Set<string> {
  const covered = new Set<string>();
  for (const skill of mustHaveSkills) {
    if (selected.some((s) => coversSkill(s.block, skill))) {
      covered.add(skill);
    }
  }
  return covered;
}

/**
 * Greedy knapsack: sort by score, take while line + per-section caps allow.
 * Enforce ≤1 block per org unless the challenger scores ≥ gap above the incumbent.
 * Then ensure must-have coverage via swaps (re-verified so swaps never uncover
 * previously covered must-haves).
 */
export function knapsackSelect(
  scored: ScoredBlock[],
  budget: SelectionBudget | ResumeTemplateBudget,
  mustHaveSkills: string[],
  options?: { orgScoreGap?: number },
): SelectionResult {
  const b: SelectionBudget =
    "blocksPerSection" in budget && "totalLines" in budget
      ? budgetFromTemplate(budget as ResumeTemplateBudget)
      : (budget as SelectionBudget);
  const orgGap = options?.orgScoreGap ?? 0.12;

  const sorted = [...scored].sort(
    (a, c) => c.score - a.score || a.block.id.localeCompare(c.block.id),
  );

  let selected: ScoredBlock[] = [];
  let byOrg = new Map<string, ScoredBlock>();
  let sectionCounts: Partial<Record<SectionKind, number>> = {};
  let lines = 0;

  const tryAdd = (item: ScoredBlock): boolean => {
    const section = sectionForBlock(item.block);
    const cap = sectionCap(b, section);
    const count = sectionCounts[section] ?? 0;
    if (count >= cap) return false;

    const cost = estimateBlockLines(item.block);
    if (lines + cost > b.totalLines && selected.length > 0) return false;

    const orgKey = item.block.org.trim().toLowerCase() || item.block.id;
    const incumbent = byOrg.get(orgKey);
    if (incumbent) {
      if (item.score < incumbent.score + orgGap) return false;
      // Replace incumbent
      const idx = selected.findIndex((s) => s.block.id === incumbent.block.id);
      if (idx >= 0) {
        const prevSection = sectionForBlock(incumbent.block);
        sectionCounts[prevSection] = Math.max(
          0,
          (sectionCounts[prevSection] ?? 1) - 1,
        );
        lines -= estimateBlockLines(incumbent.block);
        selected.splice(idx, 1);
      }
    }

    selected.push(item);
    byOrg.set(orgKey, item);
    sectionCounts[section] = (sectionCounts[section] ?? 0) + 1;
    lines += cost;
    return true;
  };

  for (const item of sorted) {
    tryAdd(item);
  }

  // Must-have coverage: if a skill is uncovered, swap in the best covering block.
  const swaps: SwapRecord[] = [];
  const selectedIds = () => new Set(selected.map((s) => s.block.id));

  for (const skill of mustHaveSkills) {
    if (selected.some((s) => coversSkill(s.block, skill))) continue;

    const coveredBefore = coveredMustHaves(selected, mustHaveSkills);
    const snapshot = cloneSelectionState(selected);

    const candidates = sorted.filter(
      (s) => !selectedIds().has(s.block.id) && coversSkill(s.block, skill),
    );
    const best = candidates[0];
    if (!best) continue;

    // Prefer dropping the lowest-scoring selected block in the same section,
    // else the global lowest-scoring selected block.
    const section = sectionForBlock(best.block);
    const sameSection = selected.filter(
      (s) => sectionForBlock(s.block) === section,
    );
    const pool = sameSection.length > 0 ? sameSection : selected;
    let swapApplied: SwapRecord | null = null;

    if (pool.length === 0) {
      // Room under cap? try direct add
      if (tryAdd(best)) {
        swapApplied = { droppedId: "", addedId: best.block.id, skill };
      }
    } else {
      const drop = [...pool].sort((a, c) => a.score - c.score)[0]!;
      if (best.score + 0.05 < drop.score && coversSkill(drop.block, skill)) {
        // Drop already somehow covers — skip
        continue;
      }

      const dropIdx = selected.findIndex((s) => s.block.id === drop.block.id);
      if (dropIdx < 0) continue;

      const dropSection = sectionForBlock(drop.block);
      sectionCounts[dropSection] = Math.max(
        0,
        (sectionCounts[dropSection] ?? 1) - 1,
      );
      lines -= estimateBlockLines(drop.block);
      selected.splice(dropIdx, 1);
      byOrg.delete(drop.block.org.trim().toLowerCase() || drop.block.id);

      if (tryAdd(best)) {
        swapApplied = {
          droppedId: drop.block.id,
          addedId: best.block.id,
          skill,
        };
      } else {
        // Restore drop if add failed
        tryAdd(drop);
      }
    }

    if (!swapApplied) continue;

    // Re-verify: every previously covered must-have must still be covered.
    const uncoveredNow = [...coveredBefore].filter(
      (s) => !selected.some((x) => coversSkill(x.block, s)),
    );
    if (uncoveredNow.length > 0) {
      // Revert uncovering swap
      selected = snapshot.selected;
      byOrg = snapshot.byOrg;
      sectionCounts = snapshot.sectionCounts;
      lines = snapshot.lines;
      continue;
    }

    swaps.push(swapApplied);
  }

  // Final pass: ensure swap set didn't leave any must-have worse than start of swaps.
  // (Individual swaps already verified; recompute uncovered for the report.)
  const uncoveredMustHaves = mustHaveSkills.filter(
    (skill) => !selected.some((s) => coversSkill(s.block, skill)),
  );

  // Stable order: by score desc
  selected.sort(
    (a, c) => c.score - a.score || a.block.id.localeCompare(c.block.id),
  );

  return { selected, uncoveredMustHaves, swaps };
}

/** Assert selection respects per-section caps and total line budget. */
export function assertBudgetInvariants(
  selected: ScoredBlock[],
  budget: SelectionBudget | ResumeTemplateBudget,
): { ok: boolean; violations: string[] } {
  // Same resolution as knapsackSelect: page totalLines minus fixed overhead.
  const b = budgetFromTemplate(budget as ResumeTemplateBudget);
  const violations: string[] = [];
  const sectionCounts: Partial<Record<SectionKind, number>> = {};
  let lines = 0;
  for (const s of selected) {
    const section = sectionForBlock(s.block);
    sectionCounts[section] = (sectionCounts[section] ?? 0) + 1;
    lines += estimateBlockLines(s.block);
  }
  for (const [section, count] of Object.entries(sectionCounts)) {
    const cap = sectionCap(b, section as SectionKind);
    if ((count ?? 0) > cap) {
      violations.push(`${section}: ${count} blocks exceeds cap ${cap}`);
    }
  }
  if (lines > b.totalLines && selected.length > 0) {
    // Allow slight overflow only when a single block exceeds budget alone
    const minCost = Math.min(
      ...selected.map((s) => estimateBlockLines(s.block)),
    );
    if (!(selected.length === 1 && minCost > b.totalLines)) {
      violations.push(`totalLines ${lines} exceeds budget ${b.totalLines}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

export interface TrimBulletsOptions {
  /** Max bullets kept per block (locked bullets always kept and count toward cap). */
  maxBulletsPerBlock?: number;
  /** bulletId → relevance in [0,1] from embedding search (missing → 0). */
  relevanceByBulletId?: Map<string, number>;
  /** Prefer bullets that mention these skills when scores tie. */
  mustHaveSkills?: string[];
}

/**
 * After knapsack block selection, rank each block's bullets by embedding
 * relevance (plus must-have keyword boost) and trim to a per-block budget.
 * Locked bullets are always retained. Returns new ScoredBlock copies.
 */
export function trimSelectedBullets(
  selected: ScoredBlock[],
  options: TrimBulletsOptions = {},
): ScoredBlock[] {
  const maxPer = options.maxBulletsPerBlock ?? DEFAULT_MAX_BULLETS_PER_BLOCK;
  const relevance = options.relevanceByBulletId ?? new Map<string, number>();
  const mustHaves = options.mustHaveSkills ?? [];

  return selected.map((item) => {
    const bullets = item.block.bullets;
    if (bullets.length <= maxPer) {
      return item;
    }

    const locked = bullets.filter((b) => b.locked);
    const unlocked = bullets.filter((b) => !b.locked);

    const scoreBullet = (b: Bullet): number => {
      const emb = relevance.get(b.id) ?? 0;
      let boost = 0;
      for (const skill of mustHaves) {
        if (bulletCoversSkill(b, skill)) boost += 0.15;
      }
      return Math.min(1, emb + boost);
    };

    const ranked = [...unlocked].sort((a, c) => {
      const diff = scoreBullet(c) - scoreBullet(a);
      if (diff !== 0) return diff;
      return a.id.localeCompare(c.id);
    });

    const slotsLeft = Math.max(0, maxPer - locked.length);
    const keptUnlocked = ranked.slice(
      0,
      Math.max(slotsLeft, locked.length === 0 ? 1 : 0),
    );
    // Preserve original order among kept bullets.
    const keptIds = new Set([
      ...locked.map((b) => b.id),
      ...keptUnlocked.map((b) => b.id),
    ]);
    // Ensure at least one bullet when the block had any.
    if (keptIds.size === 0 && bullets[0]) {
      keptIds.add(bullets[0].id);
    }
    const trimmed = bullets.filter((b) => keptIds.has(b.id));

    return {
      ...item,
      block: { ...item.block, bullets: trimmed },
    };
  });
}

/** Cosine similarity for equal-length vectors; returns 0 on empty/mismatch. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

export interface MmrCandidate<T> {
  item: T;
  /** Similarity to the query in [-1, 1] (typically cosine). */
  relevance: number;
  /** Embedding used for pairwise diversity. */
  vec: number[];
}

/**
 * Maximal Marginal Relevance: pick `k` items balancing relevance vs diversity.
 * `lambda` closer to 1 favors relevance; closer to 0 favors diversity.
 */
export function mmrSelect<T>(
  candidates: MmrCandidate<T>[],
  k: number,
  lambda = 0.7,
): T[] {
  if (k <= 0 || candidates.length === 0) return [];
  const remaining = [...candidates];
  const selected: MmrCandidate<T>[] = [];

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      const rel = c.relevance;
      let maxSim = 0;
      for (const s of selected) {
        const sim = cosineSimilarity(c.vec, s.vec);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (
        mmr > bestScore ||
        (mmr === bestScore &&
          String(c.item).localeCompare(String(remaining[bestIdx]!.item)) < 0)
      ) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }

  return selected.map((s) => s.item);
}
