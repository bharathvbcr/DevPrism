import type {
  ExperienceBlock,
  Persona,
  SeniorityLevel,
} from "@/lib/career/types";
import type {
  HeaderFields,
  ResumeContent,
  ResumeTemplateBudget,
} from "@/lib/resume-templates/types";
import type {
  MatchReportAtsParse,
  MatchReportKeywordHeatmap,
} from "./ats-simulate";

export type { MatchReportAtsParse, MatchReportKeywordHeatmap };

/** Pipeline stages reported via `onProgress` / synthesis-store. */
export type SynthesisStageId =
  | "idle"
  | "analyzing"
  | "scoring"
  | "selecting"
  | "evidence"
  | "rewriting"
  | "critic"
  | "assembling"
  | "done"
  | "error"
  | "cancelled";

/** Per-block rewrite row for the stage checklist UI. */
export type RewriteBlockStatus = "pending" | "active" | "done" | "error";

export interface RewriteBlockProgress {
  blockId: string;
  /** Display label, e.g. org or title. */
  label: string;
  /** 1-based index among selected blocks. */
  index: number;
  total: number;
  status: RewriteBlockStatus;
  /** Live raw/phrasing preview while streaming this block. */
  streamPreview?: string;
}

export interface SynthesisStage {
  id: SynthesisStageId;
  label: string;
  detail?: string;
  /** 0–1 overall progress hint. */
  progress?: number;
  /**
   * Partial match report available as soon as selection finishes (stage 3).
   * Critique/repairs may still be null/empty until later stages.
   */
  partialReport?: MatchReport;
  /** Populated during stage 5 (rewriting) for per-block checklist rows. */
  blockProgress?: RewriteBlockProgress[];
  /**
   * Live token preview for non-rewrite stages (JD analysis, critic).
   * Rewrite previews live on `blockProgress[].streamPreview`.
   */
  streamPreview?: string;
  /**
   * Per-LLM-call heartbeat for non-streaming backends / live pane.
   * Powers "Waiting on model · 14s · 1.2k chars".
   */
  llmCall?: {
    label: string;
    startedAt: number;
    charsReceived: number;
  };
}

export interface JDProfile {
  roleTitle: string;
  seniority: SeniorityLevel | string;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  domains: string[];
  atsKeywords: string[];
  toneSignals: string[];
  /** Facet text used for multi-vector retrieval (may equal slices of the JD). */
  responsibilitiesText: string;
  qualificationsText: string;
}

export interface ScoreComponents {
  embedding: number;
  skills: number;
  persona: number;
  recency: number;
  seniority: number;
}

export interface ScoredBlock {
  block: ExperienceBlock;
  score: number;
  components: ScoreComponents;
}

export interface JdFacets {
  full: number[] | null;
  responsibilities: number[] | null;
  qualifications: number[] | null;
  /** True when embeddings were unavailable and scoring used tag-only weights. */
  semanticMatchingDisabled: boolean;
  notice?: string;
}

/**
 * Why a bullet fell back to canonical text.
 * `null` when the AI rewrite was kept.
 */
export type BulletFallbackReason =
  | "llm-failed"
  | "metrics-lost"
  | "latex-rejected"
  | "over-budget"
  | "locked"
  | "invalid-provenance"
  | null;

export interface RewrittenBullet {
  id: string;
  text: string;
  /** True when we fell back to canonical (lock / invariant / repair). */
  usedCanonical: boolean;
  /**
   * Why we fell back to canonical; `null` when AI text was kept.
   * Omitted on older persisted runs.
   */
  fallbackReason?: BulletFallbackReason;
  /** Fact ids cited by the distill step (empty when canonical fallback). */
  sourceFactIds?: string[];
  /** Canonical bullet this rewrite is based on; null/omitted when fact-only distill. */
  sourceBulletId?: string | null;
}

export interface RewrittenBlockDraft {
  block: ExperienceBlock;
  bullets: RewrittenBullet[];
  evidence: string[];
  /** Top-ranked facts fed into stage 5 distill (stage 4 retrieval). */
  rankedFacts?: Array<{ id: string; text: string }>;
  score: number;
  components: ScoreComponents;
}

/** Ranked facts retrieved per selected block (stage 4). */
export interface BlockFactEvidenceSummary {
  blockId: string;
  title: string;
  org: string;
  facts: Array<{ id: string; text: string }>;
}

export interface CriticBulletVerdict {
  blockId: string;
  bulletId: string;
  grounded: boolean;
  keywordHits: string[];
  flags: string[];
}

export interface CriticResult {
  atsCoveragePct: number;
  verdicts: CriticBulletVerdict[];
  programmaticFlags: string[];
  /** Non-fatal linguistic and formatting quality warnings. */
  qualityFlags?: string[];
  /** True when the LLM critic call failed and only programmatic ATS was used. */
  llmSkipped?: boolean;
}

/**
 * Per-must-have skill coverage for the MatchReport heatmap.
 * `selectionHits` = covered by selected block skill tags / domains / bullets.
 * `rewriteHits` = covered by rewritten bullet text (post stage 5–6).
 */
export interface MustHaveCoverage {
  skill: string;
  status: "covered" | "uncovered";
  selectionHits: Array<{ blockId: string; bulletId?: string }>;
  rewriteHits: Array<{ blockId: string; bulletId?: string }>;
}

/** Wall-clock ms spent in each pipeline stage (data for expandable details UI). */
export type StageTimingsMs = Partial<
  Record<
    Exclude<SynthesisStageId, "idle" | "done" | "error" | "cancelled">,
    number
  >
>;

/** Append-only pipeline telemetry for the run activity view. */
export type RunEvent =
  | {
      type: "stage-start";
      stage: Exclude<SynthesisStageId, "idle" | "done" | "error" | "cancelled">;
      at: number;
      detail?: string;
    }
  | {
      type: "stage-finish";
      stage: Exclude<SynthesisStageId, "idle" | "done" | "error" | "cancelled">;
      at: number;
      durationMs: number;
      detail?: string;
    }
  | {
      type: "block-rewrite-start";
      blockId: string;
      label: string;
      index: number;
      total: number;
      at: number;
    }
  | {
      type: "block-rewrite-stream";
      blockId: string;
      preview: string;
      at: number;
    }
  | {
      type: "block-rewrite-done";
      blockId: string;
      at: number;
      fallbackCount: number;
      bulletCount: number;
    }
  | {
      type: "bullet-fallback";
      blockId: string;
      bulletId: string;
      reason: Exclude<BulletFallbackReason, null>;
      at: number;
    }
  | { type: "embeddings-disabled"; reason: string; at: number }
  | { type: "evidence-empty"; blockId?: string; reason: string; at: number }
  | { type: "critic-skipped"; reason: string; at: number }
  | { type: "jd-extraction-empty"; at: number }
  | { type: "compile-attempt"; attempt: number; detail: string; at: number }
  | { type: "compile-retry"; attempt: number; detail: string; at: number }
  | {
      type: "error";
      message: string;
      at: number;
      stage?: SynthesisStageId;
    };

export interface BulletFallbackSummary {
  blockId: string;
  bulletId: string;
  reason: Exclude<BulletFallbackReason, null>;
}

export interface BlockEvidenceSummary {
  blockId: string;
  title: string;
  org: string;
  chunks: string[];
}

/**
 * Per-bullet provenance from distill & rewrite (stage 5).
 * Optional on older persisted runs — UI uses optional chaining.
 */
export interface BulletProvenance {
  blockId: string;
  bulletId: string;
  /** Facts distilled into this bullet. */
  sourceFactIds?: string[];
  /** Canonical bullet this was rewritten from (when applicable). */
  sourceBulletId?: string | null;
  /** Short evidence snippets (KB chunks / fact text). */
  evidenceSnippets?: string[];
  /** True when distilled from facts with no canonical source bullet. */
  factOnly?: boolean;
}

/** Where a must-have skill was found during gap analysis. */
export type GapHitKind =
  | "block-skill"
  | "block-domain"
  | "bullet"
  | "fact"
  | "kb";

export interface GapHit {
  kind: GapHitKind;
  blockId?: string;
  bulletId?: string;
  factId?: string;
  /** Short snippet for UI chips. */
  text?: string;
}

export type GapCoverageStatus = "covered" | "weak" | "missing";

/** One must-have skill in the gap-analysis panel. */
export interface GapAnalysisItem {
  skill: string;
  status: GapCoverageStatus;
  /** Where coverage was found (block titles, fact snippets) — UI chips. */
  evidence?: string[];
  /** Actionable suggestion when weak/missing. */
  suggestion?: string;
  /** Structured hits on selected blocks. */
  selectedHits?: GapHit[];
  /** Hits only in non-selected pool blocks. */
  poolHits?: GapHit[];
  /** Hits in knowledge-base chunk text. */
  kbHits?: GapHit[];
}

/** Stage 3b gap analysis (pure TS, no extra LLM). */
export interface GapAnalysis {
  items: GapAnalysisItem[];
  summary?: string;
  coveredCount?: number;
  weakCount?: number;
  missingCount?: number;
}

/** Per-block canonical vs tailored bullets for results diffs. */
export interface BlockBulletDiff {
  blockId: string;
  title: string;
  org?: string;
  bullets: Array<{
    bulletId?: string;
    canonical: string;
    tailored: string;
    changed: boolean;
    provenance?: Pick<
      BulletProvenance,
      "sourceFactIds" | "sourceBulletId" | "evidenceSnippets"
    >;
  }>;
}

export interface MatchReport {
  profile: JDProfile;
  scored: Array<{
    blockId: string;
    title: string;
    org: string;
    score: number;
    components: ScoreComponents;
    selected: boolean;
  }>;
  selectedBlockIds: string[];
  notices: string[];
  semanticMatchingDisabled: boolean;
  critique: CriticResult | null;
  /**
   * Slots reverted to canonical text by the removed LaTeX compile-repair loop.
   * Only present on runs created before Typst became the resume engine — Typst
   * content cannot break compilation, so nothing populates this any more.
   */
  repairs?: string[];
  /** Per-stage elapsed milliseconds (populated on final report; may be partial earlier). */
  stageTimingsMs?: StageTimingsMs;
  /** Per-must-have skill → which block/bullet covers it (heatmap data). */
  mustHaveCoverage?: MustHaveCoverage[];
  /** Bullets that kept AI rewrite text (`usedCanonical: false`). */
  aiRewrittenCount?: number;
  /** Bullets that fell back to canonical (any reason including locked). */
  canonicalFallbackCount?: number;
  /** Per-bullet fallback reasons (omit when none fell back). */
  bulletFallbackReasons?: BulletFallbackSummary[];
  /** Knowledge-base evidence chunks used per selected block. */
  blockEvidence?: BlockEvidenceSummary[];
  /** Ranked facts retrieved for distill (stage 4 → 5). */
  blockFacts?: BlockFactEvidenceSummary[];
  /**
   * Per-bullet fact/evidence provenance from distill & rewrite.
   * Absent on older runs — UI hides chips gracefully.
   */
  bulletProvenance?: BulletProvenance[];
  /**
   * Must-have gap analysis (covered / weak / missing) with suggestions.
   * Absent on older runs — UI hides the panel gracefully.
   */
  gapAnalysis?: GapAnalysis;
  /**
   * Optional precomputed before/after diffs (when ResumeContent is not available,
   * e.g. stored runs without materialized content).
   */
  blockDiffs?: BlockBulletDiff[];
  /**
   * ATS parse simulation of the final printed document (IgniteCV port):
   * detected sections, required-section gaps, contact survival, formatting
   * hazards. Absent on older runs — UI hides gracefully.
   */
  atsParse?: MatchReportAtsParse;
  /**
   * JD keyword density heatmap across resume sections (IgniteCV port).
   * Absent on older runs.
   */
  keywordHeatmap?: MatchReportKeywordHeatmap;
}

export interface SynthesisResult {
  /** Null when the run could not be persisted to the career DB. */
  runId: string | null;
  /**
   * Template that produced this result. Materialization needs it to pick the
   * right engine and file extension (`.tex` vs `.typ`).
   */
  templateId: string;
  /** Assembled document source — LaTeX or Typst, per the template's engine. */
  tex: string;
  content: ResumeContent;
  report: MatchReport;
  /** Compile-verify succeeded (PDF bytes live in the temp compile path; UI materializes later). */
  compileOk: boolean;
  compileSummary: string;
  /** PDF bytes from a successful Typst compile, when the engine produced one. */
  pdfBytes?: Uint8Array | null;
}

export interface SynthesizeResumeOptions {
  jdText: string;
  personaId: string;
  templateId: string;
  onProgress?: (stage: SynthesisStage) => void;
  /** Append-only run telemetry (stage timing, fallbacks, degradation). */
  onEvent?: (event: RunEvent) => void;
  /** Optional contact header; defaults to empty placeholders. */
  header?: HeaderFields;
  /** Abort mid-pipeline (checked between stages and rewrite iterations). */
  signal?: AbortSignal;
  /** Injected for tests. */
  deps?: Partial<SynthesisDeps>;
}

export interface SynthesisDeps {
  listBlocks: () => Promise<ExperienceBlock[]>;
  listPersonas: () => Promise<Persona[]>;
  vectorSearch: (
    queryVec: number[],
    k: number,
    filter?: { ownerKind?: string },
  ) => Promise<
    Array<{ ownerId: string; score: number; text: string; meta?: unknown }>
  >;
  saveRun: (run: {
    id: string;
    jdHash: string;
    personaId: string;
    templateId: string;
    reportJson: unknown;
    createdAt: number;
  }) => Promise<void>;
  llmJson: <T>(options: {
    system: string;
    prompt: string;
    temperature?: number;
    validate: (value: unknown) => value is T;
    label?: string;
    signal?: AbortSignal;
    streamComplete?: SynthesisDeps["streamComplete"];
    onStreamPreview?: (preview: string, raw: string) => void;
    /** Bypass semantic-layer answer cache (synthesis always sets true). */
    skipSemanticCache?: boolean;
  }) => Promise<T>;
  /**
   * Optional streaming completion for rewrite preview.
   * When absent or failing, rewrite falls back to `llmJson`.
   */
  streamComplete?: (
    options: {
      system: string;
      prompt: string;
      temperature?: number;
      signal?: AbortSignal;
    },
    onChunk: (fragment: string) => void,
  ) => Promise<string>;
  embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
  compile: (
    template: import("@/lib/resume-templates/types").ResumeTemplate,
    content: ResumeContent,
    options?: {
      sectionOrder?: import("@/lib/resume-templates/types").SectionKind[];
      onAttempt?: (detail: string, attempt: number) => void;
      signal?: AbortSignal;
    },
  ) => Promise<{
    tex: string;
    content: ResumeContent;
    result: { success: boolean; summary: string };
    pdfBytes?: Uint8Array | null;
    pageCount?: number | null;
  }>;
}

export type { ResumeTemplateBudget, HeaderFields, Persona, ExperienceBlock };
