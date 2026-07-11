/**
 * Stage 6 — Programmatic invariants + LLM critic + targeted repair.
 */

import type { ExperienceBlock, Persona } from "@/lib/career/types";
import { llmJson } from "./llm-json";
import {
  enforceBulletInvariants,
  hasForbiddenLatex,
  metricsPreserved,
  validateRewriteBlockOut,
  type RewriteBlockOut,
} from "./rewrite";
import type {
  CriticBulletVerdict,
  CriticResult,
  JDProfile,
  RewrittenBlockDraft,
  RewrittenBullet,
} from "./types";

const CRITIC_SYSTEM = `You critique rewritten resume bullets for grounding and ATS coverage.
Return ONLY JSON:
{
  "atsCoveragePct": number (0-100),
  "verdicts":[{
    "blockId": string,
    "bulletId": string,
    "grounded": boolean,
    "keywordHits": string[],
    "flags": string[]
  }]
}
Rules:
- grounded=false if the bullet claims facts not entailed by its canonical text or evidence.
- flags: short codes like "unsupported-claim", "metric-changed", "too-vague", "keyword-stuffing".
- keywordHits: ATS keywords that appear naturally in the bullet.
- Output ONLY JSON.`;

export interface CriticLlmOut {
  atsCoveragePct: number;
  verdicts: CriticBulletVerdict[];
}

export function validateCriticOut(value: unknown): value is CriticLlmOut {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (
    typeof o.atsCoveragePct !== "number" &&
    typeof o.atsCoveragePct !== "string"
  ) {
    // allow missing — normalize later
  }
  if (!Array.isArray(o.verdicts)) return false;
  return o.verdicts.every((v) => {
    if (!v || typeof v !== "object") return false;
    const row = v as Record<string, unknown>;
    return (
      typeof row.blockId === "string" &&
      typeof row.bulletId === "string" &&
      typeof row.grounded === "boolean"
    );
  });
}

function normalizeCriticOut(value: CriticLlmOut): CriticResult {
  const pct =
    typeof value.atsCoveragePct === "number"
      ? value.atsCoveragePct
      : Number(value.atsCoveragePct);
  return {
    atsCoveragePct: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0,
    verdicts: value.verdicts.map((v) => ({
      blockId: v.blockId,
      bulletId: v.bulletId,
      grounded: v.grounded,
      keywordHits: Array.isArray(v.keywordHits)
        ? v.keywordHits.filter((k): k is string => typeof k === "string")
        : [],
      flags: Array.isArray(v.flags)
        ? v.flags.filter((k): k is string => typeof k === "string")
        : [],
    })),
    programmaticFlags: [],
  };
}

/** Cheap deterministic checks before the LLM critic. */
export function runProgrammaticChecks(
  drafts: RewrittenBlockDraft[],
  perBullet: number,
): string[] {
  const flags: string[] = [];
  for (const d of drafts) {
    for (const bullet of d.block.bullets) {
      const rewritten = d.bullets.find((b) => b.id === bullet.id);
      if (!rewritten) {
        flags.push(`${d.block.id}:${bullet.id}:missing`);
        continue;
      }
      if (bullet.locked && rewritten.text !== bullet.canonical) {
        flags.push(`${d.block.id}:${bullet.id}:locked-mutated`);
      }
      if (!metricsPreserved(bullet, rewritten.text)) {
        flags.push(`${d.block.id}:${bullet.id}:metric-lost`);
      }
      if (hasForbiddenLatex(rewritten.text)) {
        flags.push(`${d.block.id}:${bullet.id}:latex`);
      }
      if (perBullet > 0 && rewritten.text.length > perBullet + 5) {
        flags.push(`${d.block.id}:${bullet.id}:over-budget`);
      }
    }
  }
  return flags;
}

/** Apply canonical fallback for any programmatic violation. */
export function repairProgrammatic(
  drafts: RewrittenBlockDraft[],
  perBullet: number,
): RewrittenBlockDraft[] {
  return drafts.map((d) => ({
    ...d,
    bullets: d.block.bullets.map((bullet) => {
      const rewritten =
        d.bullets.find((b) => b.id === bullet.id)?.text ?? bullet.canonical;
      return enforceBulletInvariants(rewritten, bullet, perBullet);
    }),
  }));
}

export async function runCritic(
  drafts: RewrittenBlockDraft[],
  profile: JDProfile,
  options?: { llmJson?: typeof llmJson },
): Promise<CriticResult> {
  const programmaticFlags = runProgrammaticChecks(drafts, 0);
  const call = options?.llmJson ?? llmJson;

  const payload = drafts.map((d) => ({
    blockId: d.block.id,
    title: d.block.title,
    evidence: d.evidence,
    bullets: d.block.bullets.map((b) => {
      const rw = d.bullets.find((x) => x.id === b.id);
      return {
        bulletId: b.id,
        canonical: b.canonical,
        rewritten: rw?.text ?? b.canonical,
        metrics: b.metrics.map((m) => m.value),
      };
    }),
  }));

  try {
    const raw = await call<CriticLlmOut>({
      system: CRITIC_SYSTEM,
      prompt: [
        `Role: ${profile.roleTitle}`,
        `ATS keywords: ${profile.atsKeywords.join(", ")}`,
        `Must-have: ${profile.mustHaveSkills.join(", ")}`,
        `Draft:\n${JSON.stringify(payload)}`,
      ].join("\n\n"),
      temperature: 0.1,
      validate: validateCriticOut,
      label: "critic",
    });
    const result = normalizeCriticOut(raw);
    result.programmaticFlags = programmaticFlags;
    return result;
  } catch {
    return {
      atsCoveragePct: 0,
      verdicts: [],
      programmaticFlags,
    };
  }
}

function findBullet(block: ExperienceBlock, bulletId: string) {
  return block.bullets.find((b) => b.id === bulletId);
}

/**
 * Regenerate only flagged bullets (maxRetries), then fall back to canonical.
 */
export async function repairFlagged(
  drafts: RewrittenBlockDraft[],
  critique: CriticResult,
  profile: JDProfile,
  persona: Persona,
  perBullet: number,
  options?: {
    llmJson?: typeof llmJson;
    maxRetries?: number;
    onProgress?: (
      detail: string,
      attempt: number,
      flaggedCount: number,
    ) => void;
  },
): Promise<RewrittenBlockDraft[]> {
  const maxRetries = options?.maxRetries ?? 2;
  const call = options?.llmJson ?? llmJson;
  let current = repairProgrammatic(drafts, perBullet);

  const needsRepair = (v: CriticBulletVerdict) =>
    !v.grounded ||
    v.flags.some((f) => /unsupported|metric|hallucin|invent/i.test(f));

  const flagged = critique.verdicts.filter(needsRepair);
  if (flagged.length === 0) {
    options?.onProgress?.("No critic repairs needed", 0, 0);
    return current;
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    options?.onProgress?.(
      `critic repair round ${attempt + 1}/${maxRetries} (${flagged.length} flagged)`,
      attempt + 1,
      flagged.length,
    );
    const stillBad: CriticBulletVerdict[] = [];
    for (const v of flagged) {
      const draft = current.find((d) => d.block.id === v.blockId);
      if (!draft) continue;
      const bullet = findBullet(draft.block, v.bulletId);
      if (!bullet || bullet.locked) {
        // Force canonical for locked
        current = current.map((d) => {
          if (d.block.id !== v.blockId) return d;
          return {
            ...d,
            bullets: d.bullets.map((b) =>
              b.id === v.bulletId
                ? {
                    id: b.id,
                    text: bullet?.canonical ?? b.text,
                    usedCanonical: true,
                  }
                : b,
            ),
          };
        });
        continue;
      }

      try {
        const out = await call<RewriteBlockOut>({
          system: `Fix this resume bullet. Return ONLY JSON {"bullets":[{"id":"${bullet.id}","text":string}]}.
Plain text only. Preserve metrics ${JSON.stringify(bullet.metrics.map((m) => m.value))} verbatim.
Do not invent facts beyond canonical + evidence. ≤ ${perBullet} chars.`,
          prompt: [
            `Canonical: ${bullet.canonical}`,
            `Previous rewrite: ${draft.bullets.find((b) => b.id === bullet.id)?.text ?? ""}`,
            `Flags: ${v.flags.join(", ") || "ungrounded"}`,
            `Evidence:\n${draft.evidence.join("\n") || "(none)"}`,
            `ATS keywords: ${profile.atsKeywords.join(", ")}`,
            `Tone: ${persona.toneDirective}`,
          ].join("\n"),
          temperature: 0.2,
          validate: validateRewriteBlockOut,
          label: `repair:${v.blockId}:${v.bulletId}`,
        });
        const text =
          out.bullets.find((b) => b.id === bullet.id)?.text ?? bullet.canonical;
        const fixed = enforceBulletInvariants(text, bullet, perBullet);
        current = current.map((d) => {
          if (d.block.id !== v.blockId) return d;
          return {
            ...d,
            bullets: d.bullets.map((b) => (b.id === bullet.id ? fixed : b)),
          };
        });
        if (fixed.usedCanonical || !fixed.text) {
          stillBad.push(v);
        }
      } catch {
        stillBad.push(v);
      }
    }

    if (stillBad.length === 0) break;
    // Final fallback to canonical for remaining
    if (attempt === maxRetries - 1) {
      for (const v of stillBad) {
        current = current.map((d) => {
          if (d.block.id !== v.blockId) return d;
          const bullet = findBullet(d.block, v.bulletId);
          if (!bullet) return d;
          return {
            ...d,
            bullets: d.bullets.map((b) =>
              b.id === v.bulletId
                ? ({
                    id: b.id,
                    text: bullet.canonical,
                    usedCanonical: true,
                  } satisfies RewrittenBullet)
                : b,
            ),
          };
        });
      }
    }
  }

  return repairProgrammatic(current, perBullet);
}
