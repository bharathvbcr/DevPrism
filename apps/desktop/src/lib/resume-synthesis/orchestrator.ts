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
import type { ExperienceBlock, Persona } from "@/lib/career/types";
import { aiEmbed } from "@/lib/ai-assist";
import {
  getResumeTemplate,
  type HeaderFields,
  type RenderedBlock,
  type ResumeContent,
  type SectionKind,
  type SkillGroup,
} from "@/lib/resume-templates";
import { compileWithRepairLoop } from "./compile-verify";
import { analyzeJobDescription, facetsOf } from "./jd-analysis";
import { defaultStreamComplete, llmJson } from "./llm-json";
import { runCritic, repairFlagged } from "./critic";
import { rewriteBlock } from "./rewrite";
import {
  bulletCoversSkill,
  coversSkill,
  knapsackSelect,
  mmrSelect,
  sectionForBlock,
  trimSelectedBullets,
} from "./selection";
import { scoreBlocks } from "./scoring";
import type {
  JdFacets,
  MatchReport,
  MustHaveCoverage,
  RewriteBlockProgress,
  RewrittenBlockDraft,
  ScoredBlock,
  StageTimingsMs,
  SynthesisDeps,
  SynthesisResult,
  SynthesisStage,
  SynthesizeResumeOptions,
} from "./types";
import {
  blockRewriteLabel,
  formatRewriteBlockDetail,
  initBlockProgress,
} from "./synthesis-ux";

function emit(
  onProgress: ((s: SynthesisStage) => void) | undefined,
  stage: SynthesisStage,
) {
  onProgress?.(stage);
}

/** Throws a DOMException named AbortError when the signal is aborted. */
export function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new DOMException("Synthesis cancelled", "AbortError");
  throw err;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /cancelled|aborted/i.test(e.message ?? "");
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
  profile: Awaited<ReturnType<typeof analyzeJobDescription>>,
  embed: (texts: string[]) => Promise<number[][]>,
  onFacetProgress?: (detail: string, index: number, total: number) => void,
): Promise<JdFacets> {
  const facets = facetsOf(jdText, profile);
  const texts = [facets.full, facets.responsibilities, facets.qualifications];
  const total = texts.length;
  try {
    // Embed as a batch, but report per-facet substeps for progress UX.
    onFacetProgress?.("embedding facet 1/3", 1, total);
    onFacetProgress?.("embedding facet 2/3", 2, total);
    onFacetProgress?.("embedding facet 3/3", 3, total);
    const vectors = await embed(texts);
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
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const id of blockIds) map.set(id, 0);
  if (facets.semanticMatchingDisabled) return map;

  const queries = [
    facets.full,
    facets.responsibilities,
    facets.qualifications,
  ].filter((v): v is number[] => Array.isArray(v) && v.length > 0);

  for (const q of queries) {
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
      // ignore per-facet search failures
    }
  }
  return map;
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
 * Retrieve top evidence chunks for a block using embedding-based MMR.
 * Falls back to score-ordered unique texts when embed fails.
 */
async function retrieveEvidence(
  block: ScoredBlock["block"],
  facets: JdFacets,
  vectorSearch: SynthesisDeps["vectorSearch"],
  embed: SynthesisDeps["embed"],
): Promise<string[]> {
  if (facets.semanticMatchingDisabled || !facets.full) {
    return [];
  }
  try {
    const hits = await vectorSearch(facets.full, 12, { ownerKind: "chunk" });
    if (hits.length === 0) return [];

    // Prefer chunks that mention the block title/org.
    const ranked = [...hits].sort((a, b) => {
      const boost = (t: string) => {
        const hay = t.toLowerCase();
        let s = 0;
        if (block.title && hay.includes(block.title.toLowerCase())) s += 2;
        if (block.org && hay.includes(block.org.toLowerCase())) s += 1;
        return s;
      };
      return boost(b.text) + b.score - (boost(a.text) + a.score);
    });

    const candidates = ranked
      .map((h) => ({
        text: h.text.trim(),
        score: Math.min(1, Math.max(0, h.score)),
      }))
      .filter((h) => h.text.length > 0);
    if (candidates.length === 0) return [];

    try {
      const vecs = await embed(candidates.map((c) => c.text));
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
    } catch {
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
  } catch {
    return [];
  }
}

function buildSkillsGroups(
  drafts: RewrittenBlockDraft[],
  profile: Awaited<ReturnType<typeof analyzeJobDescription>>,
): SkillGroup[] {
  const names = new Set<string>();
  for (const d of drafts) {
    for (const s of d.block.skills) {
      if (s.name.trim()) names.add(s.name.trim());
    }
  }
  for (const k of profile.atsKeywords.slice(0, 12)) {
    if (k.trim()) names.add(k.trim());
  }
  const items = [...names].slice(0, 24).join(", ");
  if (!items) return [];
  return [{ label: "Skills", items }];
}

function draftsToContent(
  drafts: RewrittenBlockDraft[],
  header: HeaderFields,
  profile: Awaited<ReturnType<typeof analyzeJobDescription>>,
  sectionOrder: SectionKind[],
): ResumeContent {
  const bySection: Partial<Record<SectionKind, RenderedBlock[]>> = {};

  for (const d of drafts) {
    const section = sectionForBlock(d.block);
    const rendered: RenderedBlock = {
      id: d.block.id,
      title: d.block.title,
      org: d.block.org,
      dateRange: formatDateRange(
        d.block.dateRange.start,
        d.block.dateRange.end,
      ),
      bullets: d.bullets.map((b) => b.text),
      canonicalBullets: d.block.bullets.map((b) => b.canonical),
    };
    (bySection[section] ??= []).push(rendered);
  }

  const summaryBits = [
    profile.roleTitle ? `Targeting ${profile.roleTitle}.` : "",
    profile.toneSignals.length
      ? `Emphasis: ${profile.toneSignals.slice(0, 4).join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    header,
    summary: summaryBits || undefined,
    canonicalSummary: summaryBits || undefined,
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
  profile: Awaited<ReturnType<typeof analyzeJobDescription>>,
  facets: JdFacets,
  critique: MatchReport["critique"],
  repairs: string[],
  extraNotices: string[],
  extras?: {
    stageTimingsMs?: StageTimingsMs;
    mustHaveCoverage?: MustHaveCoverage[];
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
    repairs,
    stageTimingsMs: extras?.stageTimingsMs,
    mustHaveCoverage: extras?.mustHaveCoverage,
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
      }));
    },
    saveRun: careerSaveRun,
    llmJson,
    streamComplete: defaultStreamComplete,
    embed: (texts, signal) => aiEmbed(texts, signal),
    compile: async (template, content, options) => {
      const result = await compileWithRepairLoop(template, content, {
        sectionOrder: options?.sectionOrder,
        onAttempt: options?.onAttempt,
      });
      return {
        tex: result.tex,
        content: result.content,
        repairs: result.repairs,
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
 * → 5 rewrite → 6 critic/repair → 7 renderTemplate + compileWithRepairLoop
 */
export async function synthesizeResume(
  options: SynthesizeResumeOptions,
): Promise<SynthesisResult> {
  const {
    jdText,
    personaId,
    templateId,
    onProgress,
    header,
    signal,
    deps: depOverrides,
  } = options;
  const deps: SynthesisDeps = { ...defaultDeps(), ...depOverrides };
  const stageTimingsMs: StageTimingsMs = {};

  const template = getResumeTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown resume template: ${templateId}`);
  }

  throwIfAborted(signal);
  emit(onProgress, {
    id: "analyzing",
    label: "Analyzing job description",
    detail: "Extracting skills, domains, and ATS keywords…",
    progress: 0.05,
  });

  const tAnalyze = startTimer();
  const personas = await deps.listPersonas();
  throwIfAborted(signal);
  const persona: Persona | undefined = personas.find((p) => p.id === personaId);
  if (!persona) {
    throw new Error(`Persona not found: ${personaId}`);
  }

  const profile = await analyzeJobDescription(jdText, {
    llmJson: (opts) =>
      deps.llmJson({
        ...opts,
        signal,
        streamComplete: deps.streamComplete
          ? (streamOpts, onChunk) =>
              deps.streamComplete!({ ...streamOpts, signal }, (fragment) => {
                throwIfAborted(signal);
                onChunk(fragment);
              })
          : undefined,
        onStreamPreview: (preview) => {
          throwIfAborted(signal);
          emit(onProgress, {
            id: "analyzing",
            label: "Analyzing job description",
            detail: "Extracting skills, domains, and ATS keywords…",
            progress: 0.08,
            streamPreview: preview,
          });
        },
      }),
  });
  recordTiming(stageTimingsMs, "analyzing", tAnalyze);
  throwIfAborted(signal);

  emit(onProgress, {
    id: "scoring",
    label: "Scoring experience blocks",
    detail: `JD profile ready — ${profile.mustHaveSkills.length} must-have skills`,
    progress: 0.2,
    partialReport: undefined,
  });

  // Attach live timings on every subsequent emit via helper.
  const withTimings = (
    partial: MatchReport | undefined,
  ): MatchReport | undefined => {
    if (!partial) return undefined;
    return { ...partial, stageTimingsMs: { ...stageTimingsMs } };
  };

  const tScore = startTimer();
  const facets = await embedFacets(
    jdText,
    profile,
    (texts) => deps.embed(texts, signal),
    (detail) => {
      throwIfAborted(signal);
      emit(onProgress, {
        id: "scoring",
        label: "Scoring experience blocks",
        detail,
        progress: 0.22,
      });
    },
  );
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

  const embeddingByBlock = await embeddingScoresByBlock(
    facets,
    blocks.map((b) => b.id),
    deps.vectorSearch,
  );
  throwIfAborted(signal);
  const scored = scoreBlocks(
    blocks,
    profile,
    persona,
    embeddingByBlock,
    facets,
  );
  recordTiming(stageTimingsMs, "scoring", tScore);
  throwIfAborted(signal);

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

  const notices: string[] = [];
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
  const partialReport = buildMatchReport(
    scored,
    selectedIdsEarly,
    profile,
    facets,
    null,
    [],
    notices,
    {
      stageTimingsMs: { ...stageTimingsMs },
      mustHaveCoverage: earlyCoverage,
    },
  );

  emit(onProgress, {
    id: "selecting",
    label: "Selecting blocks under page budget",
    detail: `Selected ${selected.length} of ${scored.length} blocks`,
    progress: 0.4,
    partialReport,
  });

  throwIfAborted(signal);
  emit(onProgress, {
    id: "evidence",
    label: "Retrieving knowledge-base evidence",
    detail: `Fetching evidence for ${selected.length} selected blocks…`,
    progress: 0.45,
    partialReport,
  });

  const tEvidence = startTimer();
  const evidenceByBlock = new Map<string, string[]>();
  await Promise.all(
    selected.map(async (s) => {
      throwIfAborted(signal);
      const ev = await retrieveEvidence(
        s.block,
        facets,
        deps.vectorSearch,
        (texts) => deps.embed(texts, signal),
      );
      evidenceByBlock.set(s.block.id, ev);
    }),
  );
  recordTiming(stageTimingsMs, "evidence", tEvidence);
  throwIfAborted(signal);

  const blockProgress: RewriteBlockProgress[] = initBlockProgress(
    selected.map((s) => ({
      blockId: s.block.id,
      label: blockRewriteLabel(s.block.org, s.block.title),
    })),
  );

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
  for (let i = 0; i < selected.length; i++) {
    throwIfAborted(signal);
    const s = selected[i]!;
    const label = blockRewriteLabel(s.block.org, s.block.title);
    const detail = formatRewriteBlockDetail(label, i + 1, selected.length);
    blockProgress[i] = {
      ...blockProgress[i]!,
      status: "active",
      streamPreview: undefined,
    };
    emit(onProgress, {
      id: "rewriting",
      label: "Rewriting selected blocks",
      detail,
      progress: 0.55 + 0.18 * (i / Math.max(1, selected.length)),
      blockProgress: blockProgress.map((b) => ({ ...b })),
      partialReport: withTimings(partialReport),
    });
    try {
      rewritten.push(
        await rewriteBlock(
          s,
          profile,
          persona,
          evidenceByBlock.get(s.block.id) ?? [],
          template.budget.perBullet,
          {
            llmJson: (opts) => deps.llmJson({ ...opts, signal }),
            streamComplete: deps.streamComplete
              ? (opts, onChunk) =>
                  deps.streamComplete!({ ...opts, signal }, (fragment) => {
                    throwIfAborted(signal);
                    onChunk(fragment);
                  })
              : undefined,
            onStreamPreview: (preview) => {
              throwIfAborted(signal);
              blockProgress[i] = {
                ...blockProgress[i]!,
                status: "active",
                streamPreview: preview,
              };
              emit(onProgress, {
                id: "rewriting",
                label: "Rewriting selected blocks",
                detail,
                progress:
                  0.55 + 0.18 * ((i + 0.5) / Math.max(1, selected.length)),
                blockProgress: blockProgress.map((b) => ({ ...b })),
                partialReport: withTimings(partialReport),
              });
            },
          },
        ),
      );
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
      rewritten.push({
        block: s.block,
        bullets: s.block.bullets.map((b) => ({
          id: b.id,
          text: b.canonical,
          usedCanonical: true,
        })),
        evidence: evidenceByBlock.get(s.block.id) ?? [],
        score: s.score,
        components: s.components,
      });
    }
    emit(onProgress, {
      id: "rewriting",
      label: "Rewriting selected blocks",
      detail,
      progress: 0.55 + 0.18 * ((i + 1) / Math.max(1, selected.length)),
      blockProgress: blockProgress.map((b) => ({ ...b })),
      partialReport: withTimings(partialReport),
    });
  }
  recordTiming(stageTimingsMs, "rewriting", tRewrite);
  throwIfAborted(signal);

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
      deps.llmJson({
        ...opts,
        signal,
        streamComplete: deps.streamComplete
          ? (streamOpts, onChunk) =>
              deps.streamComplete!({ ...streamOpts, signal }, (fragment) => {
                throwIfAborted(signal);
                onChunk(fragment);
              })
          : undefined,
        onStreamPreview: (preview) => {
          throwIfAborted(signal);
          emit(onProgress, {
            id: "critic",
            label: "Critiquing and repairing draft",
            detail: "Running grounding + ATS critic…",
            progress: 0.76,
            streamPreview: preview,
            partialReport: withTimings({
              ...partialReport,
              critique: null,
            }),
          });
        },
      }),
  });
  throwIfAborted(signal);
  const finalDrafts = await repairFlagged(
    rewritten,
    critique,
    profile,
    persona,
    template.budget.perBullet,
    {
      llmJson: (opts) => deps.llmJson({ ...opts, signal }),
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
  recordTiming(stageTimingsMs, "critic", tCritic);
  throwIfAborted(signal);

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
  const content = draftsToContent(
    finalDrafts,
    contentHeader,
    profile,
    persona.sectionOrder as SectionKind[],
  );

  const compileResult = await deps.compile(template, content, {
    sectionOrder: persona.sectionOrder as SectionKind[],
    onAttempt: (detail, attempt) => {
      throwIfAborted(signal);
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

  const report = buildMatchReport(
    scored,
    selectedIds,
    profile,
    facets,
    critique,
    compileResult.repairs,
    notices,
    {
      stageTimingsMs: { ...stageTimingsMs },
      mustHaveCoverage,
    },
  );

  const runId = newCareerId("run");
  try {
    await deps.saveRun({
      id: runId,
      jdHash: hashJd(jdText),
      personaId,
      templateId,
      // Persist tex alongside MatchReport for rematerialization.
      reportJson: { ...report, tex: compileResult.tex },
      createdAt: Date.now(),
    });
  } catch {
    notices.push("Could not persist synthesis run to career DB.");
    report.notices = [...report.notices, ...notices.slice(-1)];
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
    runId,
    tex: compileResult.tex,
    content: compileResult.content,
    report,
    compileOk: compileResult.result.success,
    compileSummary: compileResult.result.summary,
    pdfBytes: compileResult.pdfBytes ?? null,
  };
}
