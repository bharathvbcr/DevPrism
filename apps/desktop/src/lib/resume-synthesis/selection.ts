/**
 * Stage 3 — Greedy knapsack under template budget + must-have coverage.
 * Also: bullet-level trim after block selection, and embedding MMR helpers.
 */

import type { BlockKind, Bullet, ExperienceBlock } from "@/lib/career/types";
import type {
  ResumeTemplateBudget,
  SectionKind,
} from "@/lib/resume-templates/types";
import type { ScoredBlock } from "./types";
import { skillOverlap } from "./scoring";

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

const KIND_TO_SECTION: Record<BlockKind, SectionKind> = {
  experience: "experience",
  project: "projects",
  publication: "publications",
  education: "education",
  leadership: "leadership",
};

export function sectionForBlock(block: ExperienceBlock): SectionKind {
  return KIND_TO_SECTION[block.kind] ?? "experience";
}

/** Estimate line cost: ~2 header lines + 1 per bullet. */
export function estimateBlockLines(block: ExperienceBlock): number {
  return 2 + Math.max(1, block.bullets.length);
}

export function budgetFromTemplate(
  budget: ResumeTemplateBudget,
): SelectionBudget {
  return {
    totalLines: budget.totalLines,
    perBullet: budget.perBullet,
    blocksPerSection: { ...budget.blocksPerSection },
  };
}

function normHay(s: string): string {
  return s.trim().toLowerCase();
}

/** True when skill appears in block tags, domains, or any bullet text. */
export function coversSkill(block: ExperienceBlock, skill: string): boolean {
  const needle = normHay(skill);
  if (!needle) return false;
  if (skillOverlap(block.skills, [skill], [], undefined) > 0) return true;
  if (
    block.domains.some((d) => {
      const hay = normHay(d);
      return hay.includes(needle) || needle.includes(hay);
    })
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
  const needle = normHay(skill);
  if (!needle) return false;
  const hay = normHay(textOverride ?? bullet.canonical);
  return hay.includes(needle);
}

function sectionCap(budget: SelectionBudget, section: SectionKind): number {
  return budget.blocksPerSection[section] ?? 3;
}

/**
 * Greedy knapsack: sort by score, take while line + per-section caps allow.
 * Enforce ≤1 block per org unless the challenger scores ≥ gap above the incumbent.
 * Then ensure must-have coverage via swaps.
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

  const selected: ScoredBlock[] = [];
  const byOrg = new Map<string, ScoredBlock>();
  const sectionCounts: Partial<Record<SectionKind, number>> = {};
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
  const swaps: Array<{ droppedId: string; addedId: string; skill: string }> =
    [];
  const selectedIds = () => new Set(selected.map((s) => s.block.id));

  for (const skill of mustHaveSkills) {
    if (selected.some((s) => coversSkill(s.block, skill))) continue;

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
    if (pool.length === 0) {
      // Room under cap? try direct add
      if (tryAdd(best)) {
        swaps.push({ droppedId: "", addedId: best.block.id, skill });
      }
      continue;
    }
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
      swaps.push({
        droppedId: drop.block.id,
        addedId: best.block.id,
        skill,
      });
    } else {
      // Restore drop if add failed
      tryAdd(drop);
    }
  }

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
