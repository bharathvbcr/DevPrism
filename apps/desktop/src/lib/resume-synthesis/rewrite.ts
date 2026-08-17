/**
 * Stage 5 — Distill & rewrite (plain-text JSON, never LaTeX).
 * Canonical bullets + ranked facts + KB evidence → tailored bullets with provenance.
 * Prefers streaming completion for live UI preview; falls back to llmJson.
 */

import type {
  BlockFact,
  Bullet,
  BulletMetric,
  ExperienceBlock,
  Persona,
} from "@/lib/career/types";
import { llmJson, tryParseJson } from "./llm-json";
import { DEFAULT_MAX_BULLETS_PER_BLOCK } from "./selection";
import type {
  BulletFallbackReason,
  JDProfile,
  RewrittenBlockDraft,
  RewrittenBullet,
  ScoredBlock,
} from "./types";
import { extractRewriteStreamPreview } from "./synthesis-ux";

export interface RewriteBulletOut {
  id: string;
  text: string;
  sourceFactIds?: string[];
  sourceBulletId?: string | null;
}

export interface RewriteBlockOut {
  bullets: RewriteBulletOut[];
}

export type RewriteStreamComplete = (
  options: {
    system: string;
    prompt: string;
    temperature?: number;
  },
  onChunk: (fragment: string) => void,
) => Promise<string>;

export interface RewriteBlockOptions {
  llmJson?: typeof llmJson;
  /** When set, try streaming first; fall back to llmJson on failure. */
  streamComplete?: RewriteStreamComplete;
  /** Called with accumulating raw text (and a cleaned preview) during stream. */
  onStreamPreview?: (preview: string, raw: string) => void;
  /** Ranked facts from stage 4 (defaults to block.facts). */
  rankedFacts?: BlockFact[];
  /** Max bullets including fact-only distill (defaults to trim cap). */
  maxBullets?: number;
}

export interface EnforceBulletOptions {
  facts?: BlockFact[];
  sourceFactIds?: string[];
  sourceBulletId?: string | null;
}

const DISTILL_SYSTEM = `You distill resume bullets for a target job description from canonical bullets and raw facts.
Return ONLY JSON: {"bullets":[{"id":string,"text":string,"sourceFactIds":string[],"sourceBulletId":string|null}]}
Rules:
- Plain text only — no LaTeX, no backslashes, no markdown except **bold**.
- Every bullet MUST cite provenance: sourceFactIds (fact ids used) and/or sourceBulletId (canonical bullet id).
- Preserve every metric string from cited canonical bullets and cited facts VERBATIM (numbers, %, $, time units).
- Do not invent employers, tools, or outcomes beyond the canonical bullets, facts, and evidence.
- Keep each bullet ≤ the stated character budget.
- Use strong verbs; weave listed ATS keywords only where truthful.
- When rewriting a canonical bullet, keep its id and set sourceBulletId to that id.
- You MAY distill additional bullets from facts alone (sourceBulletId null, non-empty sourceFactIds) up to the bullet count cap.
- Locked bullets must be copied exactly (you will be told which) with sourceBulletId = their id.
- Output ONLY JSON.`;

/** Loose validator (critic repair still uses id+text only). */
export function validateRewriteBlockOut(
  value: unknown,
): value is RewriteBlockOut {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o.bullets)) return false;
  return o.bullets.every((b) => {
    if (!b || typeof b !== "object") return false;
    const row = b as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.text === "string";
  });
}

/** Strict distill contract: provenance fields required. */
export function validateDistillBlockOut(
  value: unknown,
): value is RewriteBlockOut {
  if (!validateRewriteBlockOut(value)) return false;
  return value.bullets.every((b) => {
    if (!Array.isArray(b.sourceFactIds)) return false;
    if (b.sourceBulletId != null && typeof b.sourceBulletId !== "string") {
      return false;
    }
    return true;
  });
}

const NUMBER_WORDS: Record<string, string> = {
  "1": "one",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
  "10": "ten",
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Edge class for a *quantity*: a match may not continue a longer number, a
 * decimal, or a word.
 *
 * The previous guards were `[^\d,]`, which let a metric be "preserved" by a
 * number that merely contained it. All of these used to return true:
 * `"25%"` in `"125%"`, `"5%"` in `"5.5%"`, `"5"` in `"5th"` and `"Q5"`,
 * `"10,000"` in `"110,000"`, `"$1.2M"` in `"1,200,000,000"`. Reporting a
 * changed number as preserved is the exact failure this gate exists to prevent.
 *
 * Kept identical to `quantity_left_ok` / `quantity_right_ok` in the Rust port
 * (`src-tauri/src/career_match/metrics.rs`); change both together.
 */
const QTY_EDGE = "[^0-9a-zA-Z.,]";

/** `(?:^|EDGE)needle(?:EDGE|$)` — both edges guarded. */
function quantityRegex(needle: string): RegExp {
  return new RegExp(
    `(?:^|${QTY_EDGE})${escapeRegex(needle)}(?:${QTY_EDGE}|$)`,
    "i",
  );
}

/** Right edge only, for metrics whose own prefix supplies the left one ($, ~). */
function quantityRegexRightOnly(needle: string): RegExp {
  return new RegExp(`${escapeRegex(needle)}(?:${QTY_EDGE}|$)`, "i");
}

/**
 * Robust boundary-aware and synonym-tolerant metric verification.
 * Checks whether a ground-truth metric (e.g. "18%", "$1.2M", "5", "10k") is preserved
 * in the synthesized bullet text without allowing scope expansion.
 */
export function metricPreservedInText(
  metricValue: string,
  text: string,
): boolean {
  const v = metricValue.trim();
  if (!v) return true;

  // 1. Exact occurrence, guarded on BOTH edges so a metric can never be
  //    satisfied by a longer number that merely contains it.
  if (quantityRegex(v).test(text)) return true;
  // Metrics that do not start with a digit ("$1.2M", "~5x") carry their own
  // left edge, so only the right edge needs guarding.
  if (!/^\d/.test(v) && quantityRegexRightOnly(v).test(text)) return true;

  const vLower = v.toLowerCase();

  // 2. Percentage checks: e.g. "25%" -> "25 percent", "25 pct", "25.0%"
  const pctMatch = vLower.match(/^(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) {
    const num = pctMatch[1]!;
    const numFloat = parseFloat(num);
    const pctPatterns = [
      new RegExp(
        `(?:^|${QTY_EDGE})${escapeRegex(num)}\\s*(?:%|percent|pct|percentage)(?:[^\\w]|$)`,
        "i",
      ),
    ];
    // The one-decimal form exists so "25%" matches "25.0%". It is only added
    // when rounding to one place is LOSSLESS, i.e. the value already has at
    // most one decimal digit. Adding it unconditionally accepted a genuinely
    // different number ("0.25%" matching "0.2%"), and because Rust's `{:.1}`
    // rounds half-to-even while `toFixed(1)` rounds half-up, the two ports
    // accepted *different* wrong numbers. Mirrored in career_match::metrics.
    const decimals = (num.split(".")[1] ?? "").length;
    if (decimals <= 1) {
      pctPatterns.push(
        new RegExp(
          // escapeRegex is essential: unescaped "1.5" makes '.' a wildcard,
          // so the metric "1.5%" matched the text "125%".
          `(?:^|${QTY_EDGE})${escapeRegex(numFloat.toFixed(1))}\\s*(?:%|percent|pct|percentage)(?:[^\\w]|$)`,
          "i",
        ),
      );
    }
    if (pctPatterns.some((p) => p.test(text))) return true;
  }

  // 3. Multiplier checks: e.g. "5x" -> "5-fold", "5 times", "5X"
  const multMatch = vLower.match(/^(\d+(?:\.\d+)?)\s*x$/);
  if (multMatch) {
    const num = multMatch[1]!;
    const multPatterns = [
      new RegExp(
        `(?:^|${QTY_EDGE})${escapeRegex(num)}\\s*(?:x|-fold|\\s*fold|\\s*times)(?:[^\\w]|$)`,
        "i",
      ),
    ];
    if (multPatterns.some((p) => p.test(text))) return true;
  }

  // 4. Currency and magnitude checks: e.g. "$1.2M", "$100K", "$5B"
  const currMatch = vLower.match(
    /^(\$|usd\s*|€|£)?\s*(\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\s*(usd)?$/,
  );
  if (currMatch) {
    const num = currMatch[2]!;
    const mag = currMatch[3];
    const numVal = parseFloat(num);

    if (mag === "m" || mag === "million") {
      const fullNum = Math.round(numVal * 1_000_000).toLocaleString("en-US");
      const fullNumPlain = String(Math.round(numVal * 1_000_000));
      const patterns = [
        new RegExp(
          `\\$?\\s*${escapeRegex(num)}\\s*(?:m|million|m\\s*usd)\\b`,
          "i",
        ),
        quantityRegex(fullNum),
        quantityRegex(fullNumPlain),
      ];
      if (patterns.some((p) => p.test(text))) return true;
    } else if (mag === "k" || mag === "thousand") {
      const fullNum = Math.round(numVal * 1_000).toLocaleString("en-US");
      const fullNumPlain = String(Math.round(numVal * 1_000));
      const patterns = [
        new RegExp(
          `\\$?\\s*${escapeRegex(num)}\\s*(?:k|thousand|k\\s*usd)\\b`,
          "i",
        ),
        quantityRegex(fullNum),
        quantityRegex(fullNumPlain),
      ];
      if (patterns.some((p) => p.test(text))) return true;
    } else if (mag === "b" || mag === "billion") {
      const fullNum = Math.round(numVal * 1_000_000_000).toLocaleString(
        "en-US",
      );
      const patterns = [
        new RegExp(
          `\\$?\\s*${escapeRegex(num)}\\s*(?:b|billion|b\\s*usd)\\b`,
          "i",
        ),
        quantityRegex(fullNum),
      ];
      if (patterns.some((p) => p.test(text))) return true;
    }
  }

  // 5. Comma-formatted numbers: e.g. "10,000" <-> "10000" <-> "10k"
  const commaMatch = v.match(/^(\d{1,3}(?:,\d{3})+)$/);
  if (commaMatch) {
    const rawDigits = v.replace(/,/g, "");
    if (quantityRegex(rawDigits).test(text)) {
      return true;
    }
    const asK = `${parseInt(rawDigits, 10) / 1000}k`;
    if (new RegExp(`\\b${asK}\\b`, "i").test(text)) return true;
  }

  // 6. Number words: "1" -> "one", "5" -> "five", etc.
  if (/^\d+$/.test(v) && NUMBER_WORDS[v]) {
    const word = NUMBER_WORDS[v]!;
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return true;
  }

  return false;
}

export function metricsPreserved(
  canonical: Pick<Bullet, "metrics">,
  text: string,
): boolean {
  return metricsValuesPreserved(canonical.metrics, text);
}

export function metricsValuesPreserved(
  metrics: BulletMetric[],
  text: string,
): boolean {
  for (const m of metrics) {
    const v = m.value?.trim();
    if (!v) continue;
    if (!metricPreservedInText(v, text)) return false;
  }
  return true;
}

/** Union metrics from a canonical bullet and cited facts. */
export function metricsFromProvenance(
  bullet: Bullet | null | undefined,
  sourceFactIds: string[],
  facts: BlockFact[],
): BulletMetric[] {
  const out: BulletMetric[] = [...(bullet?.metrics ?? [])];
  const seen = new Set(
    out.map((m) => m.value?.trim()).filter((v): v is string => !!v),
  );
  const factById = new Map(facts.map((f) => [f.id, f]));
  for (const id of sourceFactIds) {
    const fact = factById.get(id);
    if (!fact) continue;
    for (const m of fact.metrics) {
      const v = m.value?.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(m);
    }
  }
  return out;
}

/** Reject obvious LaTeX command smuggling before escape. */
export function hasForbiddenLatex(text: string): boolean {
  return /\\[a-zA-Z]+/.test(text) || /[{}]/.test(text);
}

function fallbackBullet(
  bullet: Bullet,
  reason: Exclude<BulletFallbackReason, null>,
): RewrittenBullet {
  return {
    id: bullet.id,
    text: bullet.canonical,
    usedCanonical: true,
    fallbackReason: reason,
    sourceFactIds: [],
    sourceBulletId: bullet.id,
  };
}

function citedIdsExist(sourceFactIds: string[], facts: BlockFact[]): boolean {
  if (sourceFactIds.length === 0) return true;
  const known = new Set(facts.map((f) => f.id));
  return sourceFactIds.every((id) => known.has(id));
}

/**
 * Enforce plain-text / metric / budget / lock invariants.
 * Optional provenance: cited fact ids must exist; metrics from cited
 * facts + canonical bullet must be preserved.
 */
export function enforceBulletInvariants(
  draft: string,
  bullet: Bullet,
  perBullet: number,
  options?: EnforceBulletOptions,
): RewrittenBullet {
  const facts = options?.facts ?? [];
  const sourceFactIds = options?.sourceFactIds ?? [];
  const sourceBulletId =
    options?.sourceBulletId === undefined ? bullet.id : options.sourceBulletId;

  if (bullet.locked) {
    return fallbackBullet(bullet, "locked");
  }

  if (!citedIdsExist(sourceFactIds, facts)) {
    return fallbackBullet(bullet, "invalid-provenance");
  }
  if (
    sourceBulletId != null &&
    sourceBulletId !== "" &&
    sourceBulletId !== bullet.id
  ) {
    return fallbackBullet(bullet, "invalid-provenance");
  }

  let text = draft.trim();
  if (!text) {
    return fallbackBullet(bullet, "llm-failed");
  }
  if (hasForbiddenLatex(text)) {
    return fallbackBullet(bullet, "latex-rejected");
  }

  const requiredMetrics = metricsFromProvenance(bullet, sourceFactIds, facts);
  if (!metricsValuesPreserved(requiredMetrics, text)) {
    return fallbackBullet(bullet, "metrics-lost");
  }

  if (perBullet > 0 && text.length > perBullet) {
    if (bullet.canonical.length <= perBullet) {
      return fallbackBullet(bullet, "over-budget");
    }
    text = `${text.slice(0, perBullet - 1).replace(/\s+\S*$/, "")}…`;
  }

  return {
    id: bullet.id,
    text,
    usedCanonical: false,
    fallbackReason: null,
    sourceFactIds,
    sourceBulletId: sourceBulletId ?? bullet.id,
  };
}

/**
 * Validate a fact-only distilled bullet (no canonical source).
 * On failure returns usedCanonical:true with joined fact text fallback when possible.
 */
export function enforceFactOnlyInvariants(
  draft: string,
  id: string,
  perBullet: number,
  facts: BlockFact[],
  sourceFactIds: string[],
): RewrittenBullet {
  const factFallbackText = () => {
    const parts = sourceFactIds
      .map((fid) => facts.find((f) => f.id === fid)?.text?.trim())
      .filter((t): t is string => !!t);
    let t = parts.join("; ") || draft.trim();
    if (perBullet > 0 && t.length > perBullet) {
      t = `${t.slice(0, perBullet - 1).replace(/\s+\S*$/, "")}…`;
    }
    return t;
  };

  const fail = (
    reason: Exclude<BulletFallbackReason, null>,
  ): RewrittenBullet => ({
    id,
    text: factFallbackText(),
    usedCanonical: true,
    fallbackReason: reason,
    sourceFactIds,
    sourceBulletId: null,
  });

  if (!citedIdsExist(sourceFactIds, facts) || sourceFactIds.length === 0) {
    return fail("invalid-provenance");
  }

  let text = draft.trim();
  if (!text) return fail("llm-failed");
  if (hasForbiddenLatex(text)) return fail("latex-rejected");

  const requiredMetrics = metricsFromProvenance(null, sourceFactIds, facts);
  if (!metricsValuesPreserved(requiredMetrics, text)) {
    return fail("metrics-lost");
  }

  if (perBullet > 0 && text.length > perBullet) {
    // Prefer fact fallback if under budget; else truncate.
    const fb = factFallbackText();
    if (fb.length <= perBullet && fb !== text) {
      return fail("over-budget");
    }
    text = `${text.slice(0, perBullet - 1).replace(/\s+\S*$/, "")}…`;
  }

  return {
    id,
    text,
    usedCanonical: false,
    fallbackReason: null,
    sourceFactIds,
    sourceBulletId: null,
  };
}

export function hasProvenance(bullet: RewriteBulletOut): boolean {
  const facts = Array.isArray(bullet.sourceFactIds) ? bullet.sourceFactIds : [];
  const sid = bullet.sourceBulletId;
  return facts.length > 0 || (typeof sid === "string" && sid.length > 0);
}

export function normalizeDistillBullet(
  raw: RewriteBulletOut,
  block: ExperienceBlock,
): RewriteBulletOut {
  const sourceFactIds = Array.isArray(raw.sourceFactIds)
    ? raw.sourceFactIds.filter((id): id is string => typeof id === "string")
    : [];
  let sourceBulletId: string | null =
    raw.sourceBulletId === undefined
      ? null
      : raw.sourceBulletId === null
        ? null
        : String(raw.sourceBulletId);

  // Legacy / critic-shaped output: id matches a canonical bullet → treat as rewrite.
  if (
    sourceFactIds.length === 0 &&
    (sourceBulletId == null || sourceBulletId === "") &&
    block.bullets.some((b) => b.id === raw.id)
  ) {
    sourceBulletId = raw.id;
  }

  return {
    id: raw.id,
    text: raw.text,
    sourceFactIds,
    sourceBulletId,
  };
}

export function buildRewritePrompt(
  block: ExperienceBlock,
  profile: JDProfile,
  persona: Persona,
  evidence: string[],
  perBullet: number,
  rankedFacts?: BlockFact[],
  maxBullets?: number,
): { system: string; prompt: string } {
  const facts = rankedFacts ?? block.facts ?? [];
  const cap = maxBullets ?? DEFAULT_MAX_BULLETS_PER_BLOCK;
  const bulletPayload = block.bullets.map((b) => ({
    id: b.id,
    canonical: b.canonical,
    locked: b.locked,
    metrics: b.metrics.map((m) => m.value),
    variant: b.variants[persona.id] ?? null,
  }));
  const factPayload = facts.map((f) => ({
    id: f.id,
    text: f.text,
    skills: f.skills,
    metrics: f.metrics.map((m) => m.value),
  }));
  const prompt = [
    `Target role: ${profile.roleTitle} (${profile.seniority})`,
    `Persona tone: ${persona.toneDirective || "professional, concise"}`,
    `ATS keywords to weave if truthful: ${profile.atsKeywords.join(", ") || "(none)"}`,
    `Must-have skills: ${profile.mustHaveSkills.join(", ") || "(none)"}`,
    `Char budget per bullet: ${perBullet}`,
    `Bullet count cap (incl. fact-only distill): ${cap}`,
    `Block: ${block.title} @ ${block.org}`,
    `Knowledge-base evidence (may cite specifics that appear here):\n${evidence.map((e, i) => `[${i + 1}] ${e}`).join("\n") || "(none)"}`,
    `Ranked facts (ground truth; cite by id in sourceFactIds):\n${JSON.stringify(factPayload, null, 2)}`,
    `Canonical bullets JSON:\n${JSON.stringify(bulletPayload, null, 2)}`,
    `Return {"bullets":[{"id","text","sourceFactIds","sourceBulletId"}]} with provenance on every bullet.`,
  ].join("\n\n");
  return { system: DISTILL_SYSTEM, prompt };
}

function canonicalFallback(
  scored: ScoredBlock,
  evidence: string[],
  rankedFacts: BlockFact[],
  reason: Exclude<BulletFallbackReason, null> = "llm-failed",
): RewrittenBlockDraft {
  const block = scored.block;
  return {
    block,
    bullets: block.bullets.map((b) =>
      fallbackBullet(b, b.locked ? "locked" : reason),
    ),
    evidence,
    rankedFacts: rankedFacts.map((f) => ({ id: f.id, text: f.text })),
    score: scored.score,
    components: scored.components,
  };
}

async function rewriteViaStream(
  system: string,
  prompt: string,
  streamComplete: RewriteStreamComplete,
  onStreamPreview?: RewriteBlockOptions["onStreamPreview"],
): Promise<RewriteBlockOut | null> {
  try {
    let raw = "";
    const full = await streamComplete(
      { system, prompt, temperature: 0.3 },
      (fragment) => {
        raw += fragment;
        onStreamPreview?.(extractRewriteStreamPreview(raw), raw);
      },
    );
    const text = full || raw;
    if (text && text !== raw) {
      onStreamPreview?.(extractRewriteStreamPreview(text), text);
    }
    const parsed = tryParseJson(text);
    if (validateRewriteBlockOut(parsed)) return parsed;
    return null;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "AbortError"
  );
}

function applyDistillOutput(
  scored: ScoredBlock,
  out: RewriteBlockOut,
  persona: Persona,
  evidence: string[],
  perBullet: number,
  rankedFacts: BlockFact[],
  maxBullets: number,
): RewrittenBlockDraft {
  const block = scored.block;
  const normalized = out.bullets.map((b) => normalizeDistillBullet(b, block));

  const bySourceBullet = new Map<string, RewriteBulletOut>();
  const factOnly: RewriteBulletOut[] = [];

  for (const row of normalized) {
    if (!hasProvenance(row)) continue;
    if (row.sourceBulletId) {
      // Prefer first mapping per canonical id.
      if (!bySourceBullet.has(row.sourceBulletId)) {
        bySourceBullet.set(row.sourceBulletId, row);
      }
    } else {
      factOnly.push(row);
    }
  }

  const bullets: RewrittenBullet[] = block.bullets.map((b) => {
    if (b.locked) return fallbackBullet(b, "locked");
    const row = bySourceBullet.get(b.id);
    if (!row) {
      const draft = b.variants[persona.id] ?? b.canonical;
      return enforceBulletInvariants(draft, b, perBullet, {
        facts: rankedFacts,
        sourceFactIds: [],
        sourceBulletId: b.id,
      });
    }
    return enforceBulletInvariants(row.text, b, perBullet, {
      facts: rankedFacts,
      sourceFactIds: row.sourceFactIds ?? [],
      sourceBulletId: row.sourceBulletId ?? b.id,
    });
  });

  // Distill fact-only bullets up to trim cap.
  const room = Math.max(0, maxBullets - bullets.length);
  for (const row of factOnly.slice(0, room)) {
    const id =
      row.id && !block.bullets.some((b) => b.id === row.id)
        ? row.id
        : `distill_${block.id}_${bullets.length + 1}`;
    bullets.push(
      enforceFactOnlyInvariants(
        row.text,
        id,
        perBullet,
        rankedFacts,
        row.sourceFactIds ?? [],
      ),
    );
  }

  return {
    block,
    bullets,
    evidence,
    rankedFacts: rankedFacts.map((f) => ({ id: f.id, text: f.text })),
    score: scored.score,
    components: scored.components,
  };
}

export async function rewriteBlock(
  scored: ScoredBlock,
  profile: JDProfile,
  persona: Persona,
  evidence: string[],
  perBullet: number,
  options?: RewriteBlockOptions,
): Promise<RewrittenBlockDraft> {
  const block = scored.block;
  const call = options?.llmJson ?? llmJson;
  const rankedFacts = options?.rankedFacts ?? block.facts ?? [];
  const maxBullets = options?.maxBullets ?? DEFAULT_MAX_BULLETS_PER_BLOCK;

  // All locked → skip LLM
  if (block.bullets.length > 0 && block.bullets.every((b) => b.locked)) {
    return canonicalFallback(scored, evidence, rankedFacts);
  }

  // No bullets and no facts → nothing to distill
  if (block.bullets.length === 0 && rankedFacts.length === 0) {
    return {
      block,
      bullets: [],
      evidence,
      rankedFacts: [],
      score: scored.score,
      components: scored.components,
    };
  }

  const { system, prompt } = buildRewritePrompt(
    block,
    profile,
    persona,
    evidence,
    perBullet,
    rankedFacts,
    maxBullets,
  );

  let out: RewriteBlockOut | null = null;

  if (options?.streamComplete) {
    out = await rewriteViaStream(
      system,
      prompt,
      options.streamComplete,
      options.onStreamPreview,
    );
  }

  if (!out) {
    try {
      out = await call<RewriteBlockOut>({
        system,
        prompt,
        temperature: 0.3,
        validate: (v): v is RewriteBlockOut =>
          validateDistillBlockOut(v) || validateRewriteBlockOut(v),
        label: `distill:${block.id}`,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      return canonicalFallback(scored, evidence, rankedFacts);
    }
  }

  return applyDistillOutput(
    scored,
    out,
    persona,
    evidence,
    perBullet,
    rankedFacts,
    maxBullets,
  );
}
