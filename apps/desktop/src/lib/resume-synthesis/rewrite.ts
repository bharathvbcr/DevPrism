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

/** Every metric.value must appear verbatim in rewritten text. */
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
    if (!text.includes(v)) return false;
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
