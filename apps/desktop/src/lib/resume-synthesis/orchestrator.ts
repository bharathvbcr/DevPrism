/**
 * Resume synthesis orchestrator — Stages 1–7.
 */

import {
  listBlocks as careerListBlocks,
  listPersonas as careerListPersonas,
  saveRun as careerSaveRun,
  vectorSearch as careerVectorSearch,
} from "@/lib/career";
import { computeEmbeddingText, newCareerId } from "@/lib/career/block-helpers";
import type { BlockFact, ExperienceBlock, Persona } from "@/lib/career/types";
import { aiEmbed } from "@/lib/ai-assist";
import {
  getResumeTemplate,
  type HeaderFields,
  type RenderedBlock,
  type ResumeContent,
  type SectionKind,
  type SkillGroup,
} from "@/lib/resume-templates";
import { compileResumeDocument } from "./compile-verify";
import { analyzeJobDescription, facetsOf } from "./jd-analysis";
import { defaultStreamComplete, llmJson } from "./llm-json";
import { runCritic, repairFlagged } from "./critic";
import { rewriteBlock } from "./rewrite";
import {
  bulletCoversSkill,
  coversSkill,
  cosineSimilarity,
  DEFAULT_MAX_BULLETS_PER_BLOCK,
  knapsackSelect,
  mmrSelect,
  sectionForBlock,
  trimSelectedBullets,
} from "./selection";
import { skillsMatch, textCoversSkill, scoreBlocks } from "./scoring";
import { analyzeMustHaveGaps } from "./gap-analysis";
import type {
  BlockEvidenceSummary,
  BlockFactEvidenceSummary,
  BulletFallbackSummary,
  BulletProvenance,
  GapAnalysis,
  JdFacets,
  JDProfile,
  MatchReport,
  MustHaveCoverage,
  RewriteBlockProgress,
  RewrittenBlockDraft,
  RunEvent,
  ScoredBlock,
  StageTimingsMs,
  SynthesisDeps,
  SynthesisResult,
  SynthesisStage,
  SynthesizeResumeOptions,
} from "./types";
import {
  blockRewriteLabel,
  coalesceRunEventsForPersistence,
  formatRewriteBlockDetail,
  initBlockProgress,
} from "./synthesis-ux";

function emit(
  onProgress: ((s: SynthesisStage) => void) | undefined,
  stage: SynthesisStage,
) {
  onProgress?.(stage);
}

function emitEvent(
  onEvent: ((e: RunEvent) => void) | undefined,
  event: RunEvent,
) {
  onEvent?.(event);
}

/** Count AI-kept vs canonical fallback bullets for MatchReport honesty. */
export function summarizeRewriteHonesty(drafts: RewrittenBlockDraft[]): {
  aiRewrittenCount: number;
  canonicalFallbackCount: number;
  bulletFallbackReasons: BulletFallbackSummary[];
  blockEvidence: BlockEvidenceSummary[];
  blockFacts: BlockFactEvidenceSummary[];
  bulletProvenance: BulletProvenance[];
} {
  let aiRewrittenCount = 0;
  let canonicalFallbackCount = 0;
  const bulletFallbackReasons: BulletFallbackSummary[] = [];
  const blockEvidence: BlockEvidenceSummary[] = drafts.map((d) => ({
    blockId: d.block.id,
    title: d.block.title,
    org: d.block.org,
    chunks: [...d.evidence],
  }));
  const blockFacts: BlockFactEvidenceSummary[] = drafts.map((d) => ({
    blockId: d.block.id,
    title: d.block.title,
    org: d.block.org,
    facts: [...(d.rankedFacts ?? [])],
  }));
  const bulletProvenance: BulletProvenance[] = [];

  for (const d of drafts) {
    const factText = new Map(
      (d.rankedFacts ?? []).map((f) => [f.id, f.text] as const),
    );
    for (const b of d.bullets) {
      const sourceFactIds = b.sourceFactIds ?? [];
      const sourceBulletId = b.sourceBulletId ?? null;
      const factOnly =
        !sourceBulletId &&
        sourceFactIds.length > 0 &&
        !d.block.bullets.some((c) => c.id === b.id);

      if (
        !b.usedCanonical ||
        sourceFactIds.length > 0 ||
        sourceBulletId != null
      ) {
        bulletProvenance.push({
          blockId: d.block.id,
          bulletId: b.id,
          sourceFactIds,
          sourceBulletId,
          factOnly: factOnly || undefined,
          evidenceSnippets: [
            ...sourceFactIds
              .map((id) => factText.get(id))
              .filter((t): t is string => !!t)
              .map((t) => t.slice(0, 120)),
            ...d.evidence.slice(0, 2).map((e) => e.slice(0, 120)),
          ].slice(0, 4),
        });
      }

      if (b.usedCanonical) {
        canonicalFallbackCount += 1;
        const reason = b.fallbackReason ?? "llm-failed";
        if (reason) {
          bulletFallbackReasons.push({
            blockId: d.block.id,
            bulletId: b.id,
            reason,
          });
        }
      } else {
        aiRewrittenCount += 1;
      }
    }
  }

  return {
    aiRewrittenCount,
    canonicalFallbackCount,
    bulletFallbackReasons,
    blockEvidence,
    blockFacts,
    bulletProvenance,
  };
}

/** Throws a DOMException named AbortError when the signal is aborted. */
export function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new DOMException("Synthesis cancelled", "AbortError");
  throw err;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "AbortError";
}

function hashJd(text: string): string {
  // Simple FNV-1a 32-bit for run identity (not cryptographic).
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `jd_${(h >>> 0).toString(16)}`;
}

function formatDateRange(start: string, end: string | null): string {
  const fmt = (iso: string) => {
    const m = iso.match(/^(\d{4})(?:-(\d{1,2}))?/);
    if (!m) return iso;
    const year = m[1]!;
    if (!m[2]) return year;
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const mi = Math.min(12, Math.max(1, Number(m[2]))) - 1;
    return `${months[mi]} ${year}`;
  };
  const a = start.trim() ? fmt(start.trim()) : "";
  const b = end?.trim() ? fmt(end.trim()) : "Present";
  if (!a) return b;
  return `${a} -- ${b}`;
}

type TimedStageId = keyof StageTimingsMs;

function startTimer(): number {
  return Date.now();
}

function recordTiming(
  timings: StageTimingsMs,
  id: TimedStageId,
  startedAt: number,
) {
  const prev = timings[id] ?? 0;
  timings[id] = prev + (Date.now() - startedAt);
}

async function embedFacets(
  jdText: string,
  profile: import("./types").JDProfile,
  embed: (texts: string[]) => Promise<number[][]>,
  onFacetProgress?: (detail: string, index: number, total: number) => void,
): Promise<JdFacets> {
  const facets = facetsOf(jdText, profile);
  const texts = [facets.full, facets.responsibilities, facets.qualifications];
  const total = texts.length;
  try {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      const [vec] = await embed([texts[i]!]);
      vectors.push(vec ?? []);
      onFacetProgress?.(`embedded facet ${i + 1}/${total}`, i + 1, total);
    }
    if (vectors.length < 3 || !vectors[0]?.length) {
      return {
        full: null,
        responsibilities: null,
        qualifications: null,
        semanticMatchingDisabled: true,
        notice:
          "Semantic matching disabled — embedding provider returned empty vectors. Using tag-only scoring.",
      };
    }
    return {
      full: vectors[0]!,
      responsibilities: vectors[1]!,
      qualifications: vectors[2]!,
      semanticMatchingDisabled: false,
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      full: null,
      responsibilities: null,
      qualifications: null,
      semanticMatchingDisabled: true,
      notice: `Semantic matching disabled (${message}). Using tag-only scoring.`,
    };
  }
}

async function embeddingScoresByBlock(
  facets: JdFacets,
  blockIds: string[],
  vectorSearch: SynthesisDeps["vectorSearch"],
): Promise<{ map: Map<string, number>; allSearchesFailed: boolean }> {
  const map = new Map<string, number>();
  for (const id of blockIds) map.set(id, 0);
  if (facets.semanticMatchingDisabled) {
    return { map, allSearchesFailed: false };
  }

  const queries = [
    facets.full,
    facets.responsibilities,
    facets.qualifications,
  ].filter((v): v is number[] => Array.isArray(v) && v.length > 0);

  let attempts = 0;
  let failures = 0;
  for (const q of queries) {
    attempts += 1;
    try {
      const hits = await vectorSearch(q, Math.max(blockIds.length, 32), {
        ownerKind: "block",
      });
      for (const hit of hits) {
        const prev = map.get(hit.ownerId) ?? 0;
        // Cosine may be negative; clamp contribution to [0,1]
        const s = Math.min(1, Math.max(0, hit.score));
        if (s > prev) map.set(hit.ownerId, s);
      }
    } catch {
      failures += 1;
    }
  }
  return {
    map,
    allSearchesFailed: attempts > 0 && failures === attempts,
  };
}

/**
 * Rank bullets against JD facets via `ownerKind: "bullet"` vector search.
 * Returns bulletId → max facet cosine in [0,1].
 */
async function embeddingScoresByBullet(
  facets: JdFacets,
  bulletIds: string[],
  vectorSearch: SynthesisDeps["vectorSearch"],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const id of bulletIds) map.set(id, 0);
  if (facets.semanticMatchingDisabled || bulletIds.length === 0) return map;

  const idSet = new Set(bulletIds);
  const queries = [
    facets.full,
    facets.responsibilities,
    facets.qualifications,
  ].filter((v): v is number[] => Array.isArray(v) && v.length > 0);

  for (const q of queries) {
    try {
      const hits = await vectorSearch(q, Math.max(bulletIds.length, 64), {
        ownerKind: "bullet",
      });
      for (const hit of hits) {
        if (!idSet.has(hit.ownerId)) continue;
        const prev = map.get(hit.ownerId) ?? 0;
        const s = Math.min(1, Math.max(0, hit.score));
        if (s > prev) map.set(hit.ownerId, s);
      }
    } catch {
      // ignore per-facet search failures
    }
  }
  return map;
}

/**
 * Retrieve top-k facts for a selected block ranked by JD-facet cosine
 * plus must-have keyword/skill boost. Falls back to local ranking when
 * embeddings are disabled.
 */
const FACT_RETRIEVAL_K = 8;
const MUST_HAVE_FACT_BOOST = 0.18;

function factMetaBlockId(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const blockId = (meta as Record<string, unknown>).blockId;
  return typeof blockId === "string" ? blockId : null;
}

export async function retrieveBlockFacts(
  block: ExperienceBlock,
  profile: JDProfile,
  facets: JdFacets,
  vectorSearch: SynthesisDeps["vectorSearch"],
  signal?: AbortSignal,
  topK: number = FACT_RETRIEVAL_K,
): Promise<BlockFact[]> {
  throwIfAborted(signal);
  const facts = block.facts ?? [];
  if (facts.length === 0) return [];

  const scores = new Map<string, number>();
  for (const f of facts) {
    let boost = 0;
    for (const skill of profile.mustHaveSkills) {
      if (
        f.skills.some((s) => skillsMatch(s, skill)) ||
        textCoversSkill(f.text, skill)
      ) {
        boost += MUST_HAVE_FACT_BOOST;
      }
    }
    scores.set(f.id, boost);
  }

  if (!facets.semanticMatchingDisabled) {
    const queries = [
      facets.full,
      facets.responsibilities,
      facets.qualifications,
    ].filter((v): v is number[] => Array.isArray(v) && v.length > 0);

    const factIds = new Set(facts.map((f) => f.id));
    for (const q of queries) {
      try {
        throwIfAborted(signal);
        const hits = await vectorSearch(q, Math.max(facts.length, 24), {
          ownerKind: "fact",
        });
        for (const hit of hits) {
          if (!factIds.has(hit.ownerId)) continue;
          const metaBlock = factMetaBlockId(hit.meta);
          if (metaBlock && metaBlock !== block.id) continue;
          const s = Math.min(1, Math.max(0, hit.score));
          scores.set(hit.ownerId, (scores.get(hit.ownerId) ?? 0) + s);
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        // ignore per-facet search failures
      }
    }
  }

  return [...facts]
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .slice(0, topK);
}

/** Minimum cosine similarity of a chunk to block text to attach as evidence. */
const EVIDENCE_BLOCK_SIM_FLOOR = 0.32;

function chunkLinkedToBlock(
  text: string,
  meta: unknown,
  block: ScoredBlock["block"],
): boolean {
  const hay = text.toLowerCase();
  const title = block.title?.trim().toLowerCase();
  const org = block.org?.trim().toLowerCase();
  if (title && title.length >= 3 && hay.includes(title)) return true;
  if (org && org.length >= 2 && hay.includes(org)) return true;

  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>;
    const sourceTitle =
      typeof m.sourceTitle === "string" ? m.sourceTitle.toLowerCase() : "";
    if (title && sourceTitle.includes(title)) return true;
    if (org && sourceTitle.includes(org)) return true;
    const path = Array.isArray(m.headingPath)
      ? m.headingPath
          .filter((p): p is string => typeof p === "string")
          .join(" ")
          .toLowerCase()
      : "";
    if (title && path.includes(title)) return true;
    if (org && path.includes(org)) return true;
  }
  return false;
}

/**
 * Retrieve top evidence chunks for a block using embedding-based MMR.
 * Scopes to chunks linked to the block (title/org/meta) or similar to block
 * text — not merely JD-similar — so critic grounding stays trustworthy.
 * Falls back to score-ordered unique texts when embed fails.
 */
async function retrieveEvidence(
  block: ScoredBlock["block"],
  facets: JdFacets,
  vectorSearch: SynthesisDeps["vectorSearch"],
  embed: SynthesisDeps["embed"],
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  if (facets.semanticMatchingDisabled || !facets.full) {
    return [];
  }
  try {
    const hits = await vectorSearch(facets.full, 16, { ownerKind: "chunk" });
    throwIfAborted(signal);
    if (hits.length === 0) return [];

    const linked = hits.filter((h) =>
      chunkLinkedToBlock(h.text, h.meta, block),
    );

    // Similarity floor against block text for unlinked but still relevant chunks.
    let similar: typeof hits = [];
    const unlinked = hits.filter((h) => !linked.includes(h));
    if (unlinked.length > 0) {
      try {
        const blockText = [
          block.title,
          block.org,
          ...block.bullets.map((b) => b.canonical),
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 2000);
        throwIfAborted(signal);
        const vecs = await embed(
          [blockText, ...unlinked.map((h) => h.text.trim())],
          signal,
        );
        throwIfAborted(signal);
        if (vecs.length === unlinked.length + 1 && vecs[0]?.length) {
          const blockVec = vecs[0]!;
          similar = unlinked.filter((_h, i) => {
            const v = vecs[i + 1];
            if (!v?.length) return false;
            return cosineSimilarity(blockVec, v) >= EVIDENCE_BLOCK_SIM_FLOOR;
          });
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        // Keep only metadata-linked chunks when block-similarity embed fails.
      }
    }

    const scoped = [...linked, ...similar];
    if (scoped.length === 0) return [];

    // Prefer linked chunks, then JD score.
    const ranked = [...scoped].sort((a, b) => {
      const linkBoost = (h: (typeof hits)[number]) =>
        chunkLinkedToBlock(h.text, h.meta, block) ? 2 : 0;
      return linkBoost(b) + b.score - (linkBoost(a) + a.score);
    });

    const candidates = ranked
      .map((h) => ({
        text: h.text.trim(),
        score: Math.min(1, Math.max(0, h.score)),
      }))
      .filter((h) => h.text.length > 0);
    if (candidates.length === 0) return [];

    try {
      throwIfAborted(signal);
      const vecs = await embed(
        candidates.map((c) => c.text),
        signal,
      );
      throwIfAborted(signal);
      if (
        vecs.length === candidates.length &&
        vecs.every((v) => v.length > 0)
      ) {
        const selected = mmrSelect(
          candidates.map((c, i) => ({
            item: c.text,
            relevance: c.score,
            vec: vecs[i]!,
          })),
          3,
          0.7,
        );
        return selected;
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Fall through to score-ordered unique texts.
    }

    // Fallback: diversify by rejecting near-duplicate prefixes.
    const selected: string[] = [];
    for (const h of candidates) {
      const dup = selected.some(
        (s) =>
          s.slice(0, 80) === h.text.slice(0, 80) ||
          s.includes(h.text.slice(0, 40)),
      );
      if (dup) continue;
      selected.push(h.text);
      if (selected.length >= 3) break;
    }
    return selected;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return [];
  }
}

function buildSkillsGroups(
  drafts: RewrittenBlockDraft[],
  profile: Awaited<ReturnType<typeof analyzeJobDescription>>["profile"],
): SkillGroup[] {
  const jdAsked = [
    ...profile.mustHaveSkills,
    ...profile.niceToHaveSkills,
    ...profile.atsKeywords,
  ];
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  // Prefer block skill tags that the JD actually asks for.
  for (const d of drafts) {
    for (const s of d.block.skills) {
      if (!s.name.trim()) continue;
      const asked = jdAsked.some(
        (j) => skillsMatch(s.name, j) || textCoversSkill(s.name, j),
      );
      if (asked) push(s.name);
    }
  }

  // Cap — do not dump the full ATS keyword list.
  const items = names.slice(0, 14).join(", ");
  if (!items) return [];
  return [{ label: "Skills", items }];
}

const SUMMARY_SYSTEM = `You write a 2-line professional resume summary.
Return ONLY JSON: {"summary": string}
Rules:
- Exactly 1–2 short sentences (≤ 280 chars total).
- Ground every claim in the provided selected experience (org/title/bullets/skills).
- No "Targeting …" or "Emphasis:" meta phrasing.
- Plain text only — no LaTeX, no markdown.
- Output ONLY JSON.`;

function validateSummaryOut(value: unknown): value is { summary: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof (value as { summary?: unknown }).summary === "string";
}

/**
 * LLM-drafted 2-line summary grounded in selected blocks.
 * On failure, returns undefined so the summary section is omitted.
 */
async function draftSummary(
  drafts: RewrittenBlockDraft[],
  profile: Awaited<ReturnType<typeof analyzeJobDescription>>["profile"],
  llm: SynthesisDeps["llmJson"],
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (drafts.length === 0) return undefined;
  const payload = drafts.map((d) => ({
    title: d.block.title,
    org: d.block.org,
    skills: d.block.skills.map((s) => s.name),
    bullets: d.bullets.map((b) => b.text).slice(0, 3),
  }));
  try {
    const out = await llm<{ summary: string }>({
      system: SUMMARY_SYSTEM,
      prompt: [
        `Target role: ${profile.roleTitle} (${profile.seniority})`,
        `Selected experience JSON:\n${JSON.stringify(payload)}`,
      ].join("\n\n"),
      temperature: 0.3,
      validate: validateSummaryOut,
      label: "summary",
      signal,
    });
    const summary = out.summary.trim().replace(/\s+/g, " ");
    if (!summary || /^targeting\b/i.test(summary)) return undefined;
    return summary.slice(0, 280);
  } catch {
    return undefined;
  }
}

export function draftsToContent(
  drafts: RewrittenBlockDraft[],
  header: HeaderFields,
  profile: Awaited<ReturnType<typeof analyzeJobDescription>>["profile"],
  _sectionOrder: SectionKind[],
  summary?: string,
): ResumeContent {
  const bySection: Partial<Record<SectionKind, RenderedBlock[]>> = {};

  for (const d of drafts) {
    const section = sectionForBlock(d.block);
    // location / url / extra (GPA, honors, coursework) are rendered by the
    // templates; without this mapping they were structurally unreachable.
    const rendered: RenderedBlock = {
      id: d.block.id,
      title: d.block.title,
      org: d.block.org,
      location: d.block.location,
      url: d.block.url,
      urlLabel: d.block.urlLabel,
      extra: d.block.extra,
      canonicalExtra: d.block.extra,
      dateRange: formatDateRange(
        d.block.dateRange.start,
        d.block.dateRange.end,
      ),
      bullets: d.bullets.map((b) => b.text),
      canonicalBullets: d.block.bullets.map((b) => b.canonical),
    };
    (bySection[section] ??= []).push(rendered);
  }

  return {
    header,
    summary: summary || undefined,
    canonicalSummary: summary || undefined,
    skills: buildSkillsGroups(drafts, profile),
    experience: bySection.experience ?? [],
    projects: bySection.projects,
    education: bySection.education,
    publications: bySection.publications,
    leadership: bySection.leadership,
  };
}

/**
 * Map each must-have skill to covering blocks/bullets at selection and rewrite.
 */
export function buildMustHaveCoverage(
  mustHaveSkills: string[],
  selectedBlocks: ExperienceBlock[],
  drafts?: RewrittenBlockDraft[] | null,
): MustHaveCoverage[] {
  return mustHaveSkills.map((skill) => {
    const selectionHits: MustHaveCoverage["selectionHits"] = [];
    for (const block of selectedBlocks) {
      if (!coversSkill(block, skill)) continue;
      const bulletHits = block.bullets.filter((b) =>
        bulletCoversSkill(b, skill),
      );
      if (bulletHits.length > 0) {
        for (const b of bulletHits) {
          selectionHits.push({ blockId: block.id, bulletId: b.id });
        }
      } else {
        // Covered via skill tags / domains only.
        selectionHits.push({ blockId: block.id });
      }
    }

    const rewriteHits: MustHaveCoverage["rewriteHits"] = [];
    if (drafts) {
      for (const d of drafts) {
        for (const b of d.bullets) {
          const canonical = d.block.bullets.find((x) => x.id === b.id);
          if (
            bulletCoversSkill(
              canonical ?? {
                id: b.id,
                canonical: b.text,
                variants: {},
                metrics: [],
                evidenceRefs: [],
                locked: false,
              },
              skill,
              b.text,
            )
          ) {
            rewriteHits.push({ blockId: d.block.id, bulletId: b.id });
          }
        }
        // Block-level skill tags still count after rewrite.
        if (
          coversSkill(d.block, skill) &&
          !rewriteHits.some((h) => h.blockId === d.block.id)
        ) {
          rewriteHits.push({ blockId: d.block.id });
        }
      }
    }

    const covered =
      selectionHits.length > 0 || (drafts != null && rewriteHits.length > 0);
    return {
      skill,
      status: covered ? ("covered" as const) : ("uncovered" as const),
      selectionHits,
      rewriteHits,
    };
  });
}

function buildMatchReport(
  scored: ScoredBlock[],
  selectedIds: Set<string>,
  profile: import("./types").JDProfile,
  facets: JdFacets,
  critique: MatchReport["critique"],
  extraNotices: string[],
  extras?: {
    stageTimingsMs?: StageTimingsMs;
    mustHaveCoverage?: MustHaveCoverage[];
    aiRewrittenCount?: number;
    canonicalFallbackCount?: number;
    bulletFallbackReasons?: BulletFallbackSummary[];
    blockEvidence?: BlockEvidenceSummary[];
    blockFacts?: BlockFactEvidenceSummary[];
    bulletProvenance?: BulletProvenance[];
    gapAnalysis?: GapAnalysis;
  },
): MatchReport {
  const notices = [...extraNotices];
  if (facets.notice) notices.push(facets.notice);
  return {
    profile,
    scored: scored.map((s) => ({
      blockId: s.block.id,
      title: s.block.title,
      org: s.block.org,
      score: s.score,
      components: s.components,
      selected: selectedIds.has(s.block.id),
    })),
    selectedBlockIds: [...selectedIds],
    notices,
    semanticMatchingDisabled: facets.semanticMatchingDisabled,
    critique,
    stageTimingsMs: extras?.stageTimingsMs,
    mustHaveCoverage: extras?.mustHaveCoverage,
    aiRewrittenCount: extras?.aiRewrittenCount,
    canonicalFallbackCount: extras?.canonicalFallbackCount,
    bulletFallbackReasons: extras?.bulletFallbackReasons,
    blockEvidence: extras?.blockEvidence,
    blockFacts: extras?.blockFacts,
    bulletProvenance: extras?.bulletProvenance,
    gapAnalysis: extras?.gapAnalysis,
  };
}

function defaultDeps(): SynthesisDeps {
  return {
    listBlocks: careerListBlocks,
    listPersonas: careerListPersonas,
    vectorSearch: async (queryVec, k, filter) => {
      const hits = await careerVectorSearch(queryVec, k, filter);
      return hits.map((h) => ({
        ownerId: h.ownerId,
        score: h.score,
        text: h.text,
        meta: h.meta,
      }));
    },
    saveRun: careerSaveRun,
    llmJson,
    streamComplete: defaultStreamComplete,
    embed: (texts, signal) => aiEmbed(texts, signal),
    compile: async (template, content, options) => {
      // Dispatches on `template.engine`: in-process Typst, or the LaTeX
      // render → bisect → revert repair loop.
      const result = await compileResumeDocument(template, content, {
        sectionOrder: options?.sectionOrder,
        onAttempt: options?.onAttempt,
        signal: options?.signal,
      });
      return {
        tex: result.source,
        content: result.content,
        result: {
          success: result.result.success,
          summary: result.result.summary,
        },
        pdfBytes: result.pdfBytes ?? null,
      };
    },
  };
}

/**
 * Full synthesis pipeline:
 * 1 JD analysis → 2 hybrid score → 3 knapsack + bullet trim → 4 evidence (MMR)
 * → 5 rewrite → 6 critic/repair → 7 renderResume + compileResumeDocument
 */
export async function synthesizeResume(
  options: SynthesizeResumeOptions,
): Promise<SynthesisResult> {
  const {
    jdText,
    personaId,
    templateId,
    onProgress,
    onEvent,
    header,
    signal,
    deps: depOverrides,
  } = options;
  const deps: SynthesisDeps = { ...defaultDeps(), ...depOverrides };
  const stageTimingsMs: StageTimingsMs = {};
  const runEvents: RunEvent[] = [];
  const pushEvent = (event: RunEvent) => {
    runEvents.push(event);
    emitEvent(onEvent, event);
  };

  /** Always skip semantic cache for synthesis LLM calls. */
  const llm: SynthesisDeps["llmJson"] = (opts) =>
    deps.llmJson({ ...opts, skipSemanticCache: true });

  const template = getResumeTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown resume template: ${templateId}`);
  }

  throwIfAborted(signal);
  pushEvent({
    type: "stage-start",
    stage: "analyzing",
    at: Date.now(),
    detail: "Extracting skills, domains, and ATS keywords…",
  });
  emit(onProgress, {
    id: "analyzing",
    label: "Analyzing job description",
    detail: "Extracting skills, domains, and ATS keywords…",
    progress: 0.05,
    llmCall: {
      label: "JD analysis",
      startedAt: Date.now(),
      charsReceived: 0,
    },
  });

  const tAnalyze = startTimer();
  // Attach live timings on every emit from stage 1 onward.
  const withTimings = (
    partial: MatchReport | undefined,
  ): MatchReport | undefined => {
    if (!partial) return undefined;
    return { ...partial, stageTimingsMs: { ...stageTimingsMs } };
  };
  const personas = await deps.listPersonas();
  throwIfAborted(signal);
  const persona: Persona | undefined = personas.find((p) => p.id === personaId);
  if (!persona) {
    throw new Error(`Persona not found: ${personaId}`);
  }

  const analysis = await analyzeJobDescription(jdText, {
    llmJson: (opts) =>
      llm({
        ...opts,
        signal,
        streamComplete: deps.streamComplete
          ? (streamOpts, onChunk) =>
              deps.streamComplete!({ ...streamOpts, signal }, (fragment) => {
                throwIfAborted(signal);
                onChunk(fragment);
              })
          : undefined,
        onStreamPreview: (preview, raw) => {
          throwIfAborted(signal);
          emit(onProgress, {
            id: "analyzing",
            label: "Analyzing job description",
            detail: "Extracting skills, domains, and ATS keywords…",
            progress: 0.08,
            streamPreview: preview,
            llmCall: {
              label: "JD analysis",
              startedAt: tAnalyze,
              charsReceived: raw.length,
            },
          });
        },
      }),
  });
  const profile = analysis.profile;
  recordTiming(stageTimingsMs, "analyzing", tAnalyze);
  pushEvent({
    type: "stage-finish",
    stage: "analyzing",
    at: Date.now(),
    durationMs: stageTimingsMs.analyzing ?? 0,
    detail: `${profile.mustHaveSkills.length} must-have skills`,
  });
  if (analysis.extractionEmpty) {
    pushEvent({ type: "jd-extraction-empty", at: Date.now() });
  }
  throwIfAborted(signal);

  pushEvent({
    type: "stage-start",
    stage: "scoring",
    at: Date.now(),
    detail: "Embedding JD facets…",
  });
  emit(onProgress, {
    id: "scoring",
    label: "Scoring experience blocks",
    detail: `JD profile ready — ${profile.mustHaveSkills.length} must-have skills`,
    progress: 0.2,
  });

  const tScore = startTimer();
  const facets = await embedFacets(
    jdText,
    profile,
    (texts) => deps.embed(texts, signal),
    (detail, index, total) => {
      throwIfAborted(signal);
      emit(onProgress, {
        id: "scoring",
        label: "Scoring experience blocks",
        detail,
        progress: 0.2 + 0.05 * (index / Math.max(1, total)),
      });
    },
  );
  if (facets.semanticMatchingDisabled) {
    pushEvent({
      type: "embeddings-disabled",
      reason: facets.notice ?? "Embeddings unavailable",
      at: Date.now(),
    });
  }
  throwIfAborted(signal);
  const blocks = await deps.listBlocks();
  // Ensure embeddingText is populated for any downstream use
  for (const b of blocks) {
    if (!b.embeddingText) b.embeddingText = computeEmbeddingText(b);
  }

  emit(onProgress, {
    id: "scoring",
    label: "Scoring experience blocks",
    detail: facets.semanticMatchingDisabled
      ? `Scoring ${blocks.length} candidates (tag-only — embeddings unavailable)`
      : `Scoring ${blocks.length} candidates (hybrid embedding + tags)`,
    progress: 0.25,
  });

  const { map: embeddingByBlock, allSearchesFailed } =
    await embeddingScoresByBlock(
      facets,
      blocks.map((b) => b.id),
      deps.vectorSearch,
    );
  if (allSearchesFailed && !facets.semanticMatchingDisabled) {
    facets.semanticMatchingDisabled = true;
    facets.notice =
      "Semantic matching disabled — all block vector searches failed. Using tag-only scoring.";
    pushEvent({
      type: "embeddings-disabled",
      reason: facets.notice,
      at: Date.now(),
    });
  }
  throwIfAborted(signal);
  const scored = scoreBlocks(
    blocks,
    profile,
    persona,
    embeddingByBlock,
    facets,
  );
  recordTiming(stageTimingsMs, "scoring", tScore);
  pushEvent({
    type: "stage-finish",
    stage: "scoring",
    at: Date.now(),
    durationMs: stageTimingsMs.scoring ?? 0,
    detail: `${scored.length} candidates`,
  });
  throwIfAborted(signal);

  pushEvent({
    type: "stage-start",
    stage: "selecting",
    at: Date.now(),
  });
  emit(onProgress, {
    id: "selecting",
    label: "Selecting blocks under page budget",
    detail: `Ranked ${scored.length} candidates — packing under template budget…`,
    progress: 0.35,
  });

  const tSelect = startTimer();
  const {
    selected: knapsackSelected,
    uncoveredMustHaves,
    swaps,
  } = knapsackSelect(scored, template.budget, profile.mustHaveSkills);

  const bulletIds = knapsackSelected.flatMap((s) =>
    s.block.bullets.map((b) => b.id),
  );
  const bulletRelevance = await embeddingScoresByBullet(
    facets,
    bulletIds,
    deps.vectorSearch,
  );
  throwIfAborted(signal);
  const selected = trimSelectedBullets(knapsackSelected, {
    relevanceByBulletId: bulletRelevance,
    mustHaveSkills: profile.mustHaveSkills,
  });
  recordTiming(stageTimingsMs, "selecting", tSelect);

  const notices: string[] = [...analysis.notices];
  if (facets.notice) {
    notices.push(facets.notice);
  }
  if (analysis.extractionEmpty) {
    notices.push(
      "JD extraction degraded: empty must-have skills and ATS keywords.",
    );
  }
  if (uncoveredMustHaves.length > 0) {
    notices.push(
      `Uncovered must-have skills: ${uncoveredMustHaves.join(", ")}`,
    );
  }
  for (const s of swaps) {
    notices.push(
      s.droppedId
        ? `Swapped ${s.droppedId} → ${s.addedId} for must-have "${s.skill}"`
        : `Added ${s.addedId} for must-have "${s.skill}"`,
    );
  }

  const selectedIdsEarly = new Set(selected.map((s) => s.block.id));
  const earlyCoverage = buildMustHaveCoverage(
    profile.mustHaveSkills,
    selected.map((s) => s.block),
    null,
  );

  // Stage 3b — gap analysis (pure TS). KB snippets enriched after evidence.
  let gapAnalysis = analyzeMustHaveGaps({
    mustHaveSkills: profile.mustHaveSkills,
    selectedBlocks: selected.map((s) => s.block),
    poolBlocks: scored.map((s) => s.block),
    kbChunks: [],
  });
  if (gapAnalysis.summary) {
    notices.push(gapAnalysis.summary);
  }

  const partialReport = buildMatchReport(
    scored,
    selectedIdsEarly,
    profile,
    facets,
    null,
    notices,
    {
      stageTimingsMs: { ...stageTimingsMs },
      mustHaveCoverage: earlyCoverage,
      gapAnalysis,
    },
  );

  pushEvent({
    type: "stage-finish",
    stage: "selecting",
    at: Date.now(),
    durationMs: stageTimingsMs.selecting ?? 0,
    detail: `Selected ${selected.length} of ${scored.length}${
      gapAnalysis.missingCount
        ? ` · ${gapAnalysis.missingCount} must-have(s) missing`
        : ""
    }`,
  });
  emit(onProgress, {
    id: "selecting",
    label: "Selecting blocks under page budget",
    detail: `Selected ${selected.length} of ${scored.length} blocks`,
    progress: 0.4,
    partialReport,
  });

  throwIfAborted(signal);
  pushEvent({
    type: "stage-start",
    stage: "evidence",
    at: Date.now(),
    detail: `Fetching evidence for ${selected.length} selected blocks…`,
  });
  emit(onProgress, {
    id: "evidence",
    label: "Retrieving knowledge-base evidence",
    detail: `Fetching evidence for ${selected.length} selected blocks…`,
    progress: 0.45,
    partialReport,
  });

  const tEvidence = startTimer();
  const evidenceByBlock = new Map<string, string[]>();
  const factsByBlock = new Map<string, BlockFact[]>();
  let evidenceDone = 0;
  const evidenceTotal = Math.max(1, selected.length);
  await Promise.all(
    selected.map(async (s) => {
      throwIfAborted(signal);
      const [ev, facts] = await Promise.all([
        retrieveEvidence(
          s.block,
          facets,
          deps.vectorSearch,
          (texts, sig) => deps.embed(texts, sig ?? signal),
          signal,
        ),
        retrieveBlockFacts(s.block, profile, facets, deps.vectorSearch, signal),
      ]);
      evidenceByBlock.set(s.block.id, ev);
      factsByBlock.set(s.block.id, facts);
      evidenceDone += 1;
      emit(onProgress, {
        id: "evidence",
        label: "Retrieving knowledge-base evidence",
        detail: `Evidence ${evidenceDone}/${selected.length} blocks…`,
        progress: 0.45 + 0.08 * (evidenceDone / evidenceTotal),
        partialReport: withTimings(partialReport),
      });
      if (ev.length === 0 && facts.length === 0) {
        pushEvent({
          type: "evidence-empty",
          blockId: s.block.id,
          reason: facets.semanticMatchingDisabled
            ? "Embeddings disabled — KB/fact vector search skipped"
            : "No knowledge-base chunks or ranked facts for this block",
          at: Date.now(),
        });
      }
    }),
  );

  // Enrich gap analysis with KB evidence texts.
  const kbChunks = [...evidenceByBlock.values()].flat();
  gapAnalysis = analyzeMustHaveGaps({
    mustHaveSkills: profile.mustHaveSkills,
    selectedBlocks: selected.map((s) => s.block),
    poolBlocks: scored.map((s) => s.block),
    kbChunks,
  });
  partialReport.gapAnalysis = gapAnalysis;

  recordTiming(stageTimingsMs, "evidence", tEvidence);
  const emptyEvidenceCount = selected.filter(
    (s) => (evidenceByBlock.get(s.block.id) ?? []).length === 0,
  ).length;
  const factsRetrieved = selected.reduce(
    (n, s) => n + (factsByBlock.get(s.block.id) ?? []).length,
    0,
  );
  pushEvent({
    type: "stage-finish",
    stage: "evidence",
    at: Date.now(),
    durationMs: stageTimingsMs.evidence ?? 0,
    detail:
      emptyEvidenceCount === selected.length && factsRetrieved === 0
        ? "No KB evidence or facts for any selected block"
        : `${selected.length - emptyEvidenceCount}/${selected.length} blocks grounded · ${factsRetrieved} facts ranked`,
  });
  throwIfAborted(signal);

  const blockProgress: RewriteBlockProgress[] = initBlockProgress(
    selected.map((s) => ({
      blockId: s.block.id,
      label: blockRewriteLabel(s.block.org, s.block.title),
    })),
  );

  pushEvent({
    type: "stage-start",
    stage: "rewriting",
    at: Date.now(),
  });
  emit(onProgress, {
    id: "rewriting",
    label: "Rewriting selected blocks",
    detail:
      selected.length === 0
        ? "No blocks to rewrite"
        : `Rewriting: ${blockProgress[0]?.label ?? "…"} — 0/${selected.length}`,
    progress: 0.55,
    blockProgress: blockProgress.map((b) => ({ ...b })),
    partialReport: withTimings(partialReport),
  });

  const tRewrite = startTimer();
  const rewritten: RewrittenBlockDraft[] = [];
  const rewriteStart = 0.55;
  const rewriteEnd = 0.82;
  const rewriteSpan = rewriteEnd - rewriteStart;
  for (let i = 0; i < selected.length; i++) {
    throwIfAborted(signal);
    const s = selected[i]!;
    const label = blockRewriteLabel(s.block.org, s.block.title);
    const detail = formatRewriteBlockDetail(label, i + 1, selected.length);
    const blockStartedAt = Date.now();
    blockProgress[i] = {
      ...blockProgress[i]!,
      status: "active",
      streamPreview: undefined,
    };
    pushEvent({
      type: "block-rewrite-start",
      blockId: s.block.id,
      label,
      index: i + 1,
      total: selected.length,
      at: Date.now(),
    });
    emit(onProgress, {
      id: "rewriting",
      label: "Rewriting selected blocks",
      detail,
      progress: rewriteStart + rewriteSpan * (i / Math.max(1, selected.length)),
      blockProgress: blockProgress.map((b) => ({ ...b })),
      partialReport: withTimings(partialReport),
      llmCall: {
        label: `Rewrite · ${label}`,
        startedAt: blockStartedAt,
        charsReceived: 0,
      },
    });
    try {
      const rankedFacts = factsByBlock.get(s.block.id) ?? s.block.facts ?? [];
      const draft = await rewriteBlock(
        s,
        profile,
        persona,
        evidenceByBlock.get(s.block.id) ?? [],
        template.budget.perBullet,
        {
          rankedFacts,
          maxBullets: DEFAULT_MAX_BULLETS_PER_BLOCK,
          llmJson: (opts) => llm({ ...opts, signal }),
          streamComplete: deps.streamComplete
            ? (opts, onChunk) =>
                deps.streamComplete!({ ...opts, signal }, (fragment) => {
                  throwIfAborted(signal);
                  onChunk(fragment);
                })
            : undefined,
          onStreamPreview: (preview, raw) => {
            throwIfAborted(signal);
            blockProgress[i] = {
              ...blockProgress[i]!,
              status: "active",
              streamPreview: preview,
            };
            // Live preview only — do not push per-token events into the log.
            const charFrac = Math.min(1, raw.length / 900);
            emit(onProgress, {
              id: "rewriting",
              label: "Rewriting selected blocks",
              detail,
              progress:
                rewriteStart +
                rewriteSpan *
                  ((i + 0.15 + 0.7 * charFrac) / Math.max(1, selected.length)),
              blockProgress: blockProgress.map((b) => ({ ...b })),
              partialReport: withTimings({
                ...partialReport,
                gapAnalysis,
              }),
              llmCall: {
                label: `Rewrite · ${label}`,
                startedAt: blockStartedAt,
                charsReceived: raw.length,
              },
            });
          },
        },
      );
      rewritten.push(draft);
      for (const b of draft.bullets) {
        if (b.usedCanonical && b.fallbackReason) {
          pushEvent({
            type: "bullet-fallback",
            blockId: s.block.id,
            bulletId: b.id,
            reason: b.fallbackReason,
            at: Date.now(),
          });
        }
      }
      const fallbackCount = draft.bullets.filter((b) => b.usedCanonical).length;
      pushEvent({
        type: "block-rewrite-done",
        blockId: s.block.id,
        at: Date.now(),
        fallbackCount,
        bulletCount: draft.bullets.length,
      });
      blockProgress[i] = {
        ...blockProgress[i]!,
        status: "done",
        streamPreview: undefined,
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Defensive: rewriteBlock normally falls back to canonical; mark error if it throws.
      blockProgress[i] = {
        ...blockProgress[i]!,
        status: "error",
      };
      const fallbackDraft: RewrittenBlockDraft = {
        block: s.block,
        bullets: s.block.bullets.map((b) => ({
          id: b.id,
          text: b.canonical,
          usedCanonical: true,
          fallbackReason: b.locked
            ? ("locked" as const)
            : ("llm-failed" as const),
          sourceFactIds: [],
          sourceBulletId: b.id,
        })),
        evidence: evidenceByBlock.get(s.block.id) ?? [],
        rankedFacts: (factsByBlock.get(s.block.id) ?? []).map((f) => ({
          id: f.id,
          text: f.text,
        })),
        score: s.score,
        components: s.components,
      };
      rewritten.push(fallbackDraft);
      for (const b of fallbackDraft.bullets) {
        if (b.fallbackReason) {
          pushEvent({
            type: "bullet-fallback",
            blockId: s.block.id,
            bulletId: b.id,
            reason: b.fallbackReason,
            at: Date.now(),
          });
        }
      }
      pushEvent({
        type: "block-rewrite-done",
        blockId: s.block.id,
        at: Date.now(),
        fallbackCount: fallbackDraft.bullets.length,
        bulletCount: fallbackDraft.bullets.length,
      });
      pushEvent({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
        stage: "rewriting",
      });
    }
    emit(onProgress, {
      id: "rewriting",
      label: "Rewriting selected blocks",
      detail,
      progress:
        rewriteStart + rewriteSpan * ((i + 1) / Math.max(1, selected.length)),
      blockProgress: blockProgress.map((b) => ({ ...b })),
      partialReport: withTimings(partialReport),
    });
  }
  recordTiming(stageTimingsMs, "rewriting", tRewrite);
  pushEvent({
    type: "stage-finish",
    stage: "rewriting",
    at: Date.now(),
    durationMs: stageTimingsMs.rewriting ?? 0,
    detail: `${rewritten.length} blocks`,
  });
  throwIfAborted(signal);

  pushEvent({
    type: "stage-start",
    stage: "critic",
    at: Date.now(),
  });
  emit(onProgress, {
    id: "critic",
    label: "Critiquing and repairing draft",
    detail: "Running grounding + ATS critic…",
    progress: 0.75,
    partialReport: withTimings({
      ...partialReport,
      critique: null,
    }),
  });

  const tCritic = startTimer();
  const critique = await runCritic(rewritten, profile, {
    llmJson: (opts) =>
      llm({
        ...opts,
        signal,
        streamComplete: deps.streamComplete
          ? (streamOpts, onChunk) =>
              deps.streamComplete!({ ...streamOpts, signal }, (fragment) => {
                throwIfAborted(signal);
                onChunk(fragment);
              })
          : undefined,
        onStreamPreview: (preview, raw) => {
          throwIfAborted(signal);
          emit(onProgress, {
            id: "critic",
            label: "Critiquing and repairing draft",
            detail: "Running grounding + ATS critic…",
            progress: 0.76,
            streamPreview: preview,
            llmCall: {
              label: "Critic",
              startedAt: tCritic,
              charsReceived: raw.length,
            },
            partialReport: withTimings({
              ...partialReport,
              critique: null,
            }),
          });
        },
      }),
  });
  if (critique.llmSkipped) {
    pushEvent({
      type: "critic-skipped",
      reason: "LLM critic failed — using programmatic ATS coverage only",
      at: Date.now(),
    });
  }
  throwIfAborted(signal);
  const finalDrafts = await repairFlagged(
    rewritten,
    critique,
    profile,
    persona,
    template.budget.perBullet,
    {
      llmJson: (opts) => llm({ ...opts, signal }),
      maxRetries: 2,
      onProgress: (detail, attempt) => {
        throwIfAborted(signal);
        emit(onProgress, {
          id: "critic",
          label: "Critiquing and repairing draft",
          detail,
          progress: 0.75 + Math.min(0.1, attempt * 0.04),
          partialReport: withTimings({
            ...partialReport,
            critique,
          }),
        });
      },
    },
  );
  // Emit fallbacks introduced during critic repair.
  for (const d of finalDrafts) {
    const before = rewritten.find((r) => r.block.id === d.block.id);
    for (const b of d.bullets) {
      if (!b.usedCanonical || !b.fallbackReason) continue;
      const prev = before?.bullets.find((x) => x.id === b.id);
      if (prev?.usedCanonical && prev.fallbackReason === b.fallbackReason) {
        continue;
      }
      pushEvent({
        type: "bullet-fallback",
        blockId: d.block.id,
        bulletId: b.id,
        reason: b.fallbackReason,
        at: Date.now(),
      });
    }
  }
  recordTiming(stageTimingsMs, "critic", tCritic);
  pushEvent({
    type: "stage-finish",
    stage: "critic",
    at: Date.now(),
    durationMs: stageTimingsMs.critic ?? 0,
    detail: `ATS ${Math.round(critique.atsCoveragePct)}%`,
  });
  throwIfAborted(signal);

  pushEvent({
    type: "stage-start",
    stage: "assembling",
    at: Date.now(),
  });
  emit(onProgress, {
    id: "assembling",
    label: "Assembling LaTeX and verifying compile",
    detail: "Rendering template…",
    progress: 0.88,
    partialReport: withTimings({
      ...partialReport,
      critique,
    }),
  });

  const tAssemble = startTimer();
  const contentHeader: HeaderFields = header ?? {
    fullName: "",
    cityRegion: "",
    email: "",
    phone: "",
  };
  const summary = await draftSummary(
    finalDrafts,
    profile,
    (opts) => llm({ ...opts, signal }),
    signal,
  );
  throwIfAborted(signal);
  if (!summary) {
    notices.push(
      "Summary omitted — LLM draft failed; using experience-only resume.",
    );
  }
  const content = draftsToContent(
    finalDrafts,
    contentHeader,
    profile,
    persona.sectionOrder as SectionKind[],
    summary,
  );

  const compileResult = await deps.compile(template, content, {
    sectionOrder: persona.sectionOrder as SectionKind[],
    signal,
    onAttempt: (detail, attempt) => {
      throwIfAborted(signal);
      pushEvent({
        type: attempt === 0 ? "compile-attempt" : "compile-retry",
        attempt,
        detail,
        at: Date.now(),
      });
      emit(onProgress, {
        id: "assembling",
        label: "Assembling LaTeX and verifying compile",
        detail:
          attempt === 0
            ? detail
            : `Compile-retry attempt ${attempt}: ${detail}`,
        progress: 0.88 + Math.min(0.08, attempt * 0.03),
        partialReport: withTimings({
          ...partialReport,
          critique,
        }),
      });
    },
  });
  recordTiming(stageTimingsMs, "assembling", tAssemble);
  pushEvent({
    type: "stage-finish",
    stage: "assembling",
    at: Date.now(),
    durationMs: stageTimingsMs.assembling ?? 0,
    detail: compileResult.result.success
      ? "Compile verified"
      : "Compile needs review",
  });
  throwIfAborted(signal);

  const selectedIds = new Set(finalDrafts.map((d) => d.block.id));
  const mustHaveCoverage = buildMustHaveCoverage(
    profile.mustHaveSkills,
    selected.map((s) => s.block),
    finalDrafts,
  );
  // Recompute uncovered status from final coverage.
  for (const row of mustHaveCoverage) {
    row.status =
      row.selectionHits.length > 0 || row.rewriteHits.length > 0
        ? "covered"
        : "uncovered";
  }

  const honesty = summarizeRewriteHonesty(finalDrafts);
  const report = buildMatchReport(
    scored,
    selectedIds,
    profile,
    facets,
    critique,
    notices,
    {
      stageTimingsMs: { ...stageTimingsMs },
      mustHaveCoverage,
      gapAnalysis,
      ...honesty,
    },
  );

  const runId = newCareerId("run");
  let persistedRunId: string | null = runId;
  try {
    await deps.saveRun({
      id: runId,
      jdHash: hashJd(jdText),
      personaId,
      templateId,
      // Persist tex + coalesced events + compile status for rematerialization / activity replay.
      reportJson: {
        ...report,
        tex: compileResult.tex,
        events: coalesceRunEventsForPersistence(runEvents),
        compileOk: compileResult.result.success,
        compileSummary: compileResult.result.summary,
      },
      createdAt: Date.now(),
    });
  } catch {
    persistedRunId = null;
    const notice = "Could not persist synthesis run to career DB.";
    notices.push(notice);
    report.notices = [...report.notices, notice];
  }

  emit(onProgress, {
    id: "done",
    label: "Synthesis complete",
    detail: compileResult.result.success
      ? "Compile verified"
      : "Compile needs review",
    progress: 1,
    partialReport: report,
  });

  return {
    runId: persistedRunId,
    templateId,
    tex: compileResult.tex,
    content: compileResult.content,
    report,
    compileOk: compileResult.result.success,
    compileSummary: compileResult.result.summary,
    pdfBytes: compileResult.pdfBytes ?? null,
  };
}
