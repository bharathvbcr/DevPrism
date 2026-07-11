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

export interface RewrittenBullet {
  id: string;
  text: string;
  /** True when we fell back to canonical (lock / invariant / repair). */
  usedCanonical: boolean;
}

export interface RewrittenBlockDraft {
  block: ExperienceBlock;
  bullets: RewrittenBullet[];
  evidence: string[];
  score: number;
  components: ScoreComponents;
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
  repairs: string[];
  /** Per-stage elapsed milliseconds (populated on final report; may be partial earlier). */
  stageTimingsMs?: StageTimingsMs;
  /** Per-must-have skill → which block/bullet covers it (heatmap data). */
  mustHaveCoverage?: MustHaveCoverage[];
}

export interface SynthesisResult {
  runId: string;
  tex: string;
  content: ResumeContent;
  report: MatchReport;
  /** Compile-verify succeeded (PDF bytes live in the temp compile path; UI materializes later). */
  compileOk: boolean;
  compileSummary: string;
  /** PDF bytes from a successful `career_verify_compile`, when the engine produced one. */
  pdfBytes?: Uint8Array | null;
}

export interface SynthesizeResumeOptions {
  jdText: string;
  personaId: string;
  templateId: string;
  onProgress?: (stage: SynthesisStage) => void;
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
  ) => Promise<Array<{ ownerId: string; score: number; text: string }>>;
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
    },
  ) => Promise<{
    tex: string;
    content: ResumeContent;
    repairs: string[];
    result: { success: boolean; summary: string };
    pdfBytes?: Uint8Array | null;
  }>;
}

export type { ResumeTemplateBudget, HeaderFields, Persona, ExperienceBlock };
