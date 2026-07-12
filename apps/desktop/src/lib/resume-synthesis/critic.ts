/**
 * Stage 6 — Programmatic invariants + LLM critic + targeted repair.
 */

import type { ExperienceBlock, Persona } from "@/lib/career/types";
import { llmJson } from "./llm-json";
import {
  enforceBulletInvariants,
  enforceFactOnlyInvariants,
  hasForbiddenLatex,
  validateRewriteBlockOut,
  type RewriteBlockOut,
} from "./rewrite";
import { textCoversSkill } from "./scoring";
import type {
  CriticBulletVerdict,
  CriticResult,
  JDProfile,
  RewrittenBlockDraft,
  RewrittenBullet,
} from "./types";

const CRITIC_SYSTEM = `You critique rewritten resume bullets for grounding only.
Return ONLY JSON:
{
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
- keywordHits: ATS keywords that appear naturally in the bullet (optional hint; coverage is computed separately).
- Do NOT invent an overall ATS percentage — that is computed programmatically.
- Output ONLY JSON.`;

export interface CriticLlmOut {
  /** Optional; ignored when present — ATS % is programmatic. */
  atsCoveragePct?: number;
  verdicts: CriticBulletVerdict[];
}

export function validateCriticOut(value: unknown): value is CriticLlmOut {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
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

/**
 * Programmatic ATS coverage: fraction of JD ATS keywords that appear
 * (word-boundary) in final bullet text or skills line items.
 */
export function computeAtsCoveragePct(
  drafts: RewrittenBlockDraft[],
  atsKeywords: string[],
  skillsLineItems?: string[],
): number {
  const keywords = atsKeywords.map((k) => k.trim()).filter(Boolean);
  if (keywords.length === 0) return 0;

  const corpusParts: string[] = [];
  for (const d of drafts) {
    for (const b of d.bullets) {
      if (b.text.trim()) corpusParts.push(b.text);
    }
    for (const s of d.block.skills) {
      if (s.name.trim()) corpusParts.push(s.name);
    }
  }
  for (const item of skillsLineItems ?? []) {
    if (item.trim()) corpusParts.push(item);
  }
  const corpus = corpusParts.join("\n");
  if (!corpus.trim()) return 0;

  let hits = 0;
  for (const kw of keywords) {
    if (textCoversSkill(corpus, kw)) hits += 1;
  }
  return Math.round((100 * hits) / keywords.length);
}

function normalizeCriticOut(
  value: CriticLlmOut,
  drafts: RewrittenBlockDraft[],
  profile: JDProfile,
): CriticResult {
  return {
    atsCoveragePct: computeAtsCoveragePct(drafts, profile.atsKeywords),
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
    const blockFacts = d.block.facts ?? [];
    const canonicalIds = new Set(d.block.bullets.map((b) => b.id));

    for (const bullet of d.block.bullets) {
      const rewritten = d.bullets.find((b) => b.id === bullet.id);
      if (!rewritten) {
        flags.push(`${d.block.id}:${bullet.id}:missing`);
        continue;
      }
      if (bullet.locked && rewritten.text !== bullet.canonical) {
        flags.push(`${d.block.id}:${bullet.id}:locked-mutated`);
      }
      const required = [
        ...bullet.metrics,
        ...(rewritten.sourceFactIds ?? [])
          .map((id) => blockFacts.find((f) => f.id === id))
          .flatMap((f) => f?.metrics ?? []),
      ];
      for (const m of required) {
        const v = m.value?.trim();
        if (v && !rewritten.text.includes(v)) {
          flags.push(`${d.block.id}:${bullet.id}:metric-lost`);
          break;
        }
      }
      if (hasForbiddenLatex(rewritten.text)) {
        flags.push(`${d.block.id}:${bullet.id}:latex`);
      }
      if (perBullet > 0 && rewritten.text.length > perBullet + 5) {
        flags.push(`${d.block.id}:${bullet.id}:over-budget`);
      }
    }

    for (const rewritten of d.bullets) {
      if (canonicalIds.has(rewritten.id)) continue;
      const factIds = rewritten.sourceFactIds ?? [];
      if (factIds.length === 0) {
        flags.push(`${d.block.id}:${rewritten.id}:missing-provenance`);
      }
      for (const id of factIds) {
        if (!blockFacts.some((f) => f.id === id)) {
          flags.push(`${d.block.id}:${rewritten.id}:invalid-provenance`);
          break;
        }
      }
      if (hasForbiddenLatex(rewritten.text)) {
        flags.push(`${d.block.id}:${rewritten.id}:latex`);
      }
      if (perBullet > 0 && rewritten.text.length > perBullet + 5) {
        flags.push(`${d.block.id}:${rewritten.id}:over-budget`);
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
  return drafts.map((d) => {
    const blockFacts = d.block.facts ?? [];
    const canonicalIds = new Set(d.block.bullets.map((b) => b.id));

    const fromCanonical = d.block.bullets.map((bullet) => {
      const prev = d.bullets.find((b) => b.id === bullet.id);
      const rewritten = prev?.text ?? bullet.canonical;
      const next = enforceBulletInvariants(rewritten, bullet, perBullet, {
        facts: blockFacts,
        sourceFactIds: prev?.sourceFactIds ?? [],
        sourceBulletId: prev?.sourceBulletId ?? bullet.id,
      });
      // Re-checking an already-canonical fallback yields identical text that
      // would otherwise look like a successful AI rewrite (usedCanonical:false).
      if (prev?.usedCanonical && next.text === prev.text) {
        return {
          ...next,
          usedCanonical: true,
          fallbackReason:
            prev.fallbackReason ?? next.fallbackReason ?? "llm-failed",
          sourceFactIds: prev.sourceFactIds ?? next.sourceFactIds,
          sourceBulletId: prev.sourceBulletId ?? next.sourceBulletId,
        };
      }
      return {
        ...next,
        sourceFactIds: next.sourceFactIds ?? prev?.sourceFactIds,
        sourceBulletId: next.sourceBulletId ?? prev?.sourceBulletId,
      };
    });

    const factOnly = d.bullets
      .filter((b) => !canonicalIds.has(b.id))
      .map((prev) => {
        const next = enforceFactOnlyInvariants(
          prev.text,
          prev.id,
          perBullet,
          blockFacts,
          prev.sourceFactIds ?? [],
        );
        if (prev.usedCanonical && next.text === prev.text) {
          return {
            ...next,
            usedCanonical: true,
            fallbackReason:
              prev.fallbackReason ?? next.fallbackReason ?? "llm-failed",
          };
        }
        return next;
      });

    return { ...d, bullets: [...fromCanonical, ...factOnly] };
  });
}

export async function runCritic(
  drafts: RewrittenBlockDraft[],
  profile: JDProfile,
  options?: { llmJson?: typeof llmJson },
): Promise<CriticResult> {
  const programmaticFlags = runProgrammaticChecks(drafts, 0);
  const call = options?.llmJson ?? llmJson;
  const programmaticAts = computeAtsCoveragePct(drafts, profile.atsKeywords);

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
    const result = normalizeCriticOut(raw, drafts, profile);
    result.programmaticFlags = programmaticFlags;
    return result;
  } catch {
    return {
      atsCoveragePct: programmaticAts,
      verdicts: [],
      programmaticFlags,
      llmSkipped: true,
    };
  }
}

function findBullet(block: ExperienceBlock, bulletId: string) {
  return block.bullets.find((b) => b.id === bulletId);
}

/**
 * Regenerate only flagged bullets (maxRetries), then fall back to canonical.
 * Across rounds, only bullets that are still failing are re-repaired.
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

  let pending = critique.verdicts.filter(needsRepair);
  if (pending.length === 0) {
    options?.onProgress?.("No critic repairs needed", 0, 0);
    return current;
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    options?.onProgress?.(
      `critic repair round ${attempt + 1}/${maxRetries} (${pending.length} flagged)`,
      attempt + 1,
      pending.length,
    );
    const stillBad: CriticBulletVerdict[] = [];
    for (const v of pending) {
      const draft = current.find((d) => d.block.id === v.blockId);
      if (!draft) continue;
      const bullet = findBullet(draft.block, v.bulletId);
      if (!bullet) {
        // Fact-only distilled bullet — skip LLM repair; keep as-is.
        continue;
      }
      if (bullet.locked) {
        // Force canonical for locked
        current = current.map((d) => {
          if (d.block.id !== v.blockId) return d;
          return {
            ...d,
            bullets: d.bullets.map((b) =>
              b.id === v.bulletId
                ? {
                    id: b.id,
                    text: bullet.canonical,
                    usedCanonical: true,
                    fallbackReason: "locked" as const,
                    sourceFactIds: [],
                    sourceBulletId: bullet.id,
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
        // Successfully repaired bullets drop out of `pending` for the next round.
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          (err as { name?: string }).name === "AbortError"
        ) {
          throw err;
        }
        stillBad.push(v);
      }
    }

    pending = stillBad;
    if (pending.length === 0) break;
    // Final fallback to canonical for remaining
    if (attempt === maxRetries - 1) {
      for (const v of pending) {
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
                    fallbackReason: "llm-failed",
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
