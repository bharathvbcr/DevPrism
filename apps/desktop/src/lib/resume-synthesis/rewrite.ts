/**
 * Stage 5 — Constrained per-block rewrite (plain-text JSON, never LaTeX).
 * Prefers streaming completion for live UI preview; falls back to llmJson.
 */

import type { Bullet, ExperienceBlock, Persona } from "@/lib/career/types";
import { llmJson, tryParseJson } from "./llm-json";
import type { JDProfile, RewrittenBlockDraft, RewrittenBullet } from "./types";
import type { ScoredBlock } from "./types";
import { extractRewriteStreamPreview } from "./synthesis-ux";

export interface RewriteBulletOut {
  id: string;
  text: string;
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
}

const REWRITE_SYSTEM = `You rewrite resume bullets for a target job description.
Return ONLY JSON: {"bullets":[{"id":string,"text":string}]}
Rules:
- Plain text only — no LaTeX, no backslashes, no markdown except **bold**.
- Preserve every metric string from the source bullet VERBATIM (numbers, %, $, time units).
- Do not invent employers, tools, or outcomes beyond the canonical bullet + evidence.
- Keep each bullet ≤ the stated character budget.
- Use strong verbs; weave listed ATS keywords only where truthful.
- Keep the same bullet ids; one output entry per input bullet.
- Locked bullets must be copied exactly (you will be told which).
- Output ONLY JSON.`;

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

/** Every metric.value must appear verbatim in rewritten text. */
export function metricsPreserved(canonical: Bullet, text: string): boolean {
  for (const m of canonical.metrics) {
    const v = m.value?.trim();
    if (!v) continue;
    if (!text.includes(v)) return false;
  }
  return true;
}

/** Reject obvious LaTeX command smuggling before escape. */
export function hasForbiddenLatex(text: string): boolean {
  return /\\[a-zA-Z]+/.test(text) || /[{}]/.test(text);
}

export function enforceBulletInvariants(
  draft: string,
  bullet: Bullet,
  perBullet: number,
): RewrittenBullet {
  if (bullet.locked) {
    return { id: bullet.id, text: bullet.canonical, usedCanonical: true };
  }
  let text = draft.trim();
  if (!text) {
    return { id: bullet.id, text: bullet.canonical, usedCanonical: true };
  }
  if (hasForbiddenLatex(text)) {
    return { id: bullet.id, text: bullet.canonical, usedCanonical: true };
  }
  if (!metricsPreserved(bullet, text)) {
    return { id: bullet.id, text: bullet.canonical, usedCanonical: true };
  }
  if (perBullet > 0 && text.length > perBullet) {
    // Prefer canonical if rewrite blew the budget; else truncate at word boundary.
    if (bullet.canonical.length <= perBullet) {
      return { id: bullet.id, text: bullet.canonical, usedCanonical: true };
    }
    text = text.slice(0, perBullet - 1).replace(/\s+\S*$/, "") + "…";
  }
  return { id: bullet.id, text, usedCanonical: false };
}

export function buildRewritePrompt(
  block: ExperienceBlock,
  profile: JDProfile,
  persona: Persona,
  evidence: string[],
  perBullet: number,
): { system: string; prompt: string } {
  const bulletPayload = block.bullets.map((b) => ({
    id: b.id,
    canonical: b.canonical,
    locked: b.locked,
    metrics: b.metrics.map((m) => m.value),
    variant: b.variants[persona.id] ?? null,
  }));
  const prompt = [
    `Target role: ${profile.roleTitle} (${profile.seniority})`,
    `Persona tone: ${persona.toneDirective || "professional, concise"}`,
    `ATS keywords to weave if truthful: ${profile.atsKeywords.join(", ") || "(none)"}`,
    `Must-have skills: ${profile.mustHaveSkills.join(", ") || "(none)"}`,
    `Char budget per bullet: ${perBullet}`,
    `Block: ${block.title} @ ${block.org}`,
    `Evidence (may cite specifics that appear here):\n${evidence.map((e, i) => `[${i + 1}] ${e}`).join("\n") || "(none)"}`,
    `Bullets JSON:\n${JSON.stringify(bulletPayload, null, 2)}`,
    `Return {"bullets":[...]} with the same ids.`,
  ].join("\n\n");
  return { system: REWRITE_SYSTEM, prompt };
}

function canonicalFallback(
  scored: ScoredBlock,
  evidence: string[],
): RewrittenBlockDraft {
  const block = scored.block;
  return {
    block,
    bullets: block.bullets.map((b) => ({
      id: b.id,
      text: b.canonical,
      usedCanonical: true,
    })),
    evidence,
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
    // Prefer the resolved full string (some backends deliver one chunk at end).
    const text = full || raw;
    if (text && text !== raw) {
      onStreamPreview?.(extractRewriteStreamPreview(text), text);
    }
    const parsed = tryParseJson(text);
    if (validateRewriteBlockOut(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
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

  // All locked → skip LLM
  if (block.bullets.length > 0 && block.bullets.every((b) => b.locked)) {
    return canonicalFallback(scored, evidence);
  }

  if (block.bullets.length === 0) {
    return {
      block,
      bullets: [],
      evidence,
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
        validate: validateRewriteBlockOut,
        label: `rewrite:${block.id}`,
      });
    } catch {
      return canonicalFallback(scored, evidence);
    }
  }

  const byId = new Map(out.bullets.map((b) => [b.id, b.text]));
  const bullets = block.bullets.map((b) => {
    const draft = byId.get(b.id) ?? b.variants[persona.id] ?? b.canonical;
    return enforceBulletInvariants(draft, b, perBullet);
  });

  return {
    block,
    bullets,
    evidence,
    score: scored.score,
    components: scored.components,
  };
}
