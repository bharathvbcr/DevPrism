/**
 * Stage 2 — Hybrid scoring (deterministic, explainable components).
 *
 * score = 0.40 * embedding + 0.30 * skills + 0.15 * persona
 *       + 0.10 * recency + 0.05 * seniority
 *
 * When embeddings are unavailable, embedding weight → 0 and remaining weights
 * are renormalized.
 */

import type {
  ExperienceBlock,
  Persona,
  SeniorityLevel,
  SkillTag,
} from "@/lib/career/types";
import type {
  JDProfile,
  JdFacets,
  ScoreComponents,
  ScoredBlock,
} from "./types";

export const DEFAULT_WEIGHTS = {
  embedding: 0.4,
  skills: 0.3,
  persona: 0.15,
  recency: 0.1,
  seniority: 0.05,
} as const;

export type ScoreWeights = {
  embedding: number;
  skills: number;
  persona: number;
  recency: number;
  seniority: number;
};

/** Renormalize so weights sum to 1. Zeroes stay zero. */
export function renormalizeWeights(weights: ScoreWeights): ScoreWeights {
  const sum =
    weights.embedding +
    weights.skills +
    weights.persona +
    weights.recency +
    weights.seniority;
  if (sum <= 0) {
    return { embedding: 0, skills: 1, persona: 0, recency: 0, seniority: 0 };
  }
  return {
    embedding: weights.embedding / sum,
    skills: weights.skills / sum,
    persona: weights.persona / sum,
    recency: weights.recency / sum,
    seniority: weights.seniority / sum,
  };
}

export function weightsForFacets(facets: JdFacets): ScoreWeights {
  if (facets.semanticMatchingDisabled) {
    return renormalizeWeights({ ...DEFAULT_WEIGHTS, embedding: 0 });
  }
  return { ...DEFAULT_WEIGHTS };
}

/** Strip to lowercase alphanumeric (+ # . for C++/Node.js). */
export function normSkill(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, "");
}

/**
 * Small alias map (canonical form → aliases). Matching is bidirectional.
 * Deliberately omits dangerous short overlaps (e.g. go↛cargo, java↛javascript).
 */
const SKILL_ALIASES: Record<string, readonly string[]> = {
  javascript: ["js"],
  typescript: ["ts"],
  python: ["py"],
  golang: ["go"],
  kubernetes: ["k8s"],
  postgresql: ["postgres"],
  "c++": ["cpp", "cplusplus"],
  "c#": ["csharp"],
  "node.js": ["nodejs", "node"],
  react: ["reactjs"],
  "machine learning": ["ml"],
  "deep learning": ["dl"],
};

function aliasCanonicals(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [canon, aliases] of Object.entries(SKILL_ALIASES)) {
    const c = normSkill(canon);
    map.set(c, c);
    for (const a of aliases) {
      map.set(normSkill(a), c);
    }
  }
  return map;
}

const ALIAS_TO_CANON = aliasCanonicals();

/** Resolve a skill name to its alias-canonical form when known. */
export function canonicalSkillKey(s: string): string {
  const n = normSkill(s);
  if (!n) return "";
  return ALIAS_TO_CANON.get(n) ?? n;
}

/** Tokenize a skill into normalized word tokens (keeps #+.). */
export function skillTokens(s: string): string[] {
  return s
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Token / word-boundary skill match (no bare substring).
 * - Exact after normalize + alias canonicalization
 * - Multi-token: all target tokens appear as tokens in the haystack skill
 * - Does NOT match Java⊂JavaScript or Go⊂Cargo
 */
export function skillsMatch(a: string, b: string): boolean {
  const ca = canonicalSkillKey(a);
  const cb = canonicalSkillKey(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;

  const ta = skillTokens(a).map(
    (t) => ALIAS_TO_CANON.get(normSkill(t)) ?? normSkill(t),
  );
  const tb = skillTokens(b).map(
    (t) => ALIAS_TO_CANON.get(normSkill(t)) ?? normSkill(t),
  );
  if (ta.length === 0 || tb.length === 0) return false;

  // Single-token equality after alias (already covered by ca===cb for most cases)
  if (ta.length === 1 && tb.length === 1) {
    return ta[0] === tb[0];
  }

  // Shorter token list must be a contiguous or subset match of the longer.
  const [needle, hay] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (needle.every((t) => hay.includes(t))) {
    // Reject when a single short token is a prefix of a longer token in hay
    // (already prevented by token equality). Allow "pytorch" ⊆ "pytorch lightning".
    return true;
  }
  return false;
}

/**
 * True when `skill` appears in free text with word-boundary matching
 * (and alias variants). Avoids Go⊂Cargo / Java⊂JavaScript false positives.
 */
export function textCoversSkill(text: string, skill: string): boolean {
  const hay = text.trim().toLowerCase();
  if (!hay || !skill.trim()) return false;

  const variants = new Set<string>();
  const push = (s: string) => {
    const t = s.trim().toLowerCase();
    if (t) variants.add(t);
  };
  push(skill);
  const key = canonicalSkillKey(skill);
  if (key) {
    for (const [canon, aliases] of Object.entries(SKILL_ALIASES)) {
      if (
        normSkill(canon) === key ||
        aliases.some((a) => normSkill(a) === key)
      ) {
        push(canon);
        for (const a of aliases) push(a);
      }
    }
  }

  for (const v of variants) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word boundary that also treats non-alphanumeric as edges (C++, Node.js).
    const re = new RegExp(`(^|[^a-z0-9+#])${escaped}([^a-z0-9+.]|$)`, "i");
    if (re.test(hay)) return true;
  }
  return false;
}

/** Exact + token/alias skill overlap; must-have counts 2×. */
export function skillOverlap(
  blockSkills: SkillTag[],
  mustHave: string[],
  niceToHave: string[],
  personaWeights?: Record<string, number>,
): number {
  const names = blockSkills.map((s) => s.name).filter((n) => n.trim());
  if (names.length === 0 && mustHave.length === 0 && niceToHave.length === 0) {
    return 0;
  }

  const matchOne = (target: string): boolean => {
    if (!target.trim()) return false;
    return names.some((n) => skillsMatch(n, target));
  };

  let hits = 0;
  let weight = 0;
  for (const s of mustHave) {
    weight += 2;
    if (matchOne(s)) {
      const boost =
        personaWeights?.[s] ??
        personaWeights?.[normSkill(s)] ??
        personaWeights?.[canonicalSkillKey(s)] ??
        1;
      hits += 2 * Math.max(0.5, boost);
    }
  }
  for (const s of niceToHave) {
    weight += 1;
    if (matchOne(s)) {
      const boost =
        personaWeights?.[s] ??
        personaWeights?.[normSkill(s)] ??
        personaWeights?.[canonicalSkillKey(s)] ??
        1;
      hits += 1 * Math.max(0.5, boost);
    }
  }
  if (weight === 0) {
    // No JD skills listed — soft credit for domain-ish tags via persona weights.
    if (!personaWeights) return 0;
    let pHits = 0;
    let pW = 0;
    for (const [skill, w] of Object.entries(personaWeights)) {
      pW += Math.abs(w);
      if (matchOne(skill)) pHits += Math.abs(w);
    }
    return pW > 0 ? clamp01(pHits / pW) : 0;
  }
  return clamp01(hits / weight);
}

export function personaAffinity(
  blockPersonas: string[],
  personaId: string,
): number {
  if (!personaId) return 0.5;
  if (blockPersonas.length === 0) return 0.35;
  if (blockPersonas.includes(personaId)) return 1;
  return 0.15;
}

/** Exponential decay from end date (or start if open-ended). Half-life ~4 years. */
export function recencyDecay(
  dateRange: { start: string; end: string | null },
  now = new Date(),
): number {
  const endIso = dateRange.end?.trim() || dateRange.start?.trim() || "";
  const parsed = parseYearMonth(endIso);
  if (!parsed) return 0.5;
  const months =
    (now.getFullYear() - parsed.year) * 12 +
    (now.getMonth() + 1 - parsed.month);
  const years = Math.max(0, months / 12);
  // half-life 4y → score = 0.5^(years/4)
  return clamp01(0.5 ** (years / 4));
}

const SENIORITY_RANK: Record<string, number> = {
  ic: 0,
  senior: 1,
  lead: 2,
  manager: 3,
  director: 4,
};

export function seniorityFit(
  blockLevel: SeniorityLevel | string,
  jdSeniority: SeniorityLevel | string,
): number {
  const a = SENIORITY_RANK[String(blockLevel)] ?? 1;
  const b = SENIORITY_RANK[String(jdSeniority)] ?? 1;
  const dist = Math.abs(a - b);
  if (dist === 0) return 1;
  if (dist === 1) return 0.7;
  if (dist === 2) return 0.4;
  return 0.15;
}

function parseYearMonth(iso: string): { year: number; month: number } | null {
  const m = iso.match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 6;
  if (!Number.isFinite(year) || year < 1970) return null;
  return { year, month: Math.min(12, Math.max(1, month)) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function combineScore(
  components: ScoreComponents,
  weights: ScoreWeights,
): number {
  return clamp01(
    weights.embedding * components.embedding +
      weights.skills * components.skills +
      weights.persona * components.persona +
      weights.recency * components.recency +
      weights.seniority * components.seniority,
  );
}

/**
 * Score one block. `embeddingScore` is max facet cosine in [0,1] (or 0 when disabled).
 */
export function hybridScore(
  block: ExperienceBlock,
  profile: JDProfile,
  persona: Persona,
  embeddingScore: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  now?: Date,
): ScoredBlock {
  const components: ScoreComponents = {
    embedding: clamp01(embeddingScore),
    skills: skillOverlap(
      block.skills,
      profile.mustHaveSkills,
      profile.niceToHaveSkills,
      persona.skillWeights,
    ),
    persona: personaAffinity(block.personas, persona.id),
    recency: recencyDecay(block.dateRange, now),
    seniority: seniorityFit(block.seniorityLevel, profile.seniority),
  };
  return {
    block,
    components,
    score: combineScore(components, weights),
  };
}

/** Score all blocks given a map of blockId → max embedding similarity. */
export function scoreBlocks(
  blocks: ExperienceBlock[],
  profile: JDProfile,
  persona: Persona,
  embeddingByBlockId: Map<string, number>,
  facets: JdFacets,
  now?: Date,
): ScoredBlock[] {
  const weights = weightsForFacets(facets);
  return blocks
    .map((b) =>
      hybridScore(
        b,
        profile,
        persona,
        embeddingByBlockId.get(b.id) ?? 0,
        weights,
        now,
      ),
    )
    .sort((a, b) => b.score - a.score || a.block.id.localeCompare(b.block.id));
}
