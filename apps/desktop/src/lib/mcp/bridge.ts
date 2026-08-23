/**
 * DevPrism Career & Resume Bridge for Stateless MCP 2.0.
 *
 * High-level typed interfaces connecting UI components and AI agent workflows
 * to the Stateless MCP 2.0 backend.
 */

import { StatelessMcpClient, defaultMcpClient } from "./client";
import { InputRequiredResult } from "./types";

/**
 * Which provider supplies natural language for the two stages that need it
 * (JD analysis and bullet rewriting). Omit for `deterministic`.
 *
 * - `deterministic` — lexicon extraction, canonical bullets, no model.
 * - `agent` — you write the bullets and submit them to `verifyRewriteDrafts`.
 * - `ollama` — a local model runs in-process at zero external token cost.
 */
export interface LanguageOption {
  mode: "deterministic" | "agent" | "ollama";
  model?: string;
  baseUrl?: string;
  numCtx?: number;
  temperature?: number;
}

/**
 * Canonical JD profile — identical in shape to
 * `resume-synthesis/types.ts#JDProfile`, so a profile from the MCP server and
 * one from the in-app pipeline are interchangeable.
 *
 * Replaces an earlier `{ title, company, requiredSkills, cultureKeywords }`
 * shape that the MCP facade invented and nothing else in the app consumed.
 */
export interface JDProfile {
  roleTitle: string;
  /** Lowercase enum, never a display string. */
  seniority: "ic" | "senior" | "lead" | "manager" | "director" | string;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  domains: string[];
  atsKeywords: string[];
  toneSignals: string[];
  responsibilitiesText: string;
  qualificationsText: string;
}

export interface JDAnalysis {
  profile: JDProfile;
  /** `deterministic`, `agent`, or `ollama:<model>`. */
  source: string;
  notices: string[];
  extractionEmpty: boolean;
}

/** A skill the knowledgebase covers, and the blocks that evidence it. */
export interface CoveredSkill {
  skill: string;
  evidenceBlockIds: string[];
}

export interface GapReport {
  personaId: string;
  source: string;
  /** `null` when the JD yielded no must-have skills — unknown, not complete. */
  coveragePercentage: number | null;
  mustHave: { total: number; covered: CoveredSkill[]; missing: string[] };
  niceToHave: { total: number; covered: CoveredSkill[]; missing: string[] };
  uncoveredAfterSelection: string[];
  blocksInKnowledgebase: number;
  warnings: string[];
}

export interface ScoreComponents {
  embedding: number;
  skills: number;
  persona: number;
  recency: number;
  seniority: number;
}

export interface ScoredBlockSummary {
  blockId: string;
  title: string;
  org: string;
  kind: string;
  section: string;
  score: number;
  components: ScoreComponents;
  estimatedLines: number;
  bulletIds: string[];
}

export interface SelectionReport {
  personaId: string;
  source: string;
  semanticMatchingDisabled: boolean;
  profile: JDProfile;
  pageBudget: number;
  lineBudget: number;
  estimatedLinesUsed: number;
  selectedBlocks: ScoredBlockSummary[];
  allScores: ScoredBlockSummary[];
  mustHaveSwaps: Array<{ droppedId: string; addedId: string; skill: string }>;
  uncoveredMustHaves: string[];
  budgetViolations: string[];
  notices: string[];
}

/** Why a candidate rewrite was replaced by the canonical bullet. */
export type FallbackReason =
  | "llm-failed"
  | "metrics-lost"
  | "over-budget"
  | "locked"
  | "invalid-provenance"
  | "fabricated-metric"
  | "no-change";

export interface RewrittenBullet {
  id: string;
  /** The user's verified text; always the fallback. */
  canonical: string;
  /** What will actually be rendered. */
  text: string;
  /** True only when a model produced `text` *and* it passed verification. */
  aiGenerated: boolean;
  fallbackReason?: FallbackReason;
  droppedMetrics?: string[];
}

export interface RewriteResult {
  blockId: string;
  title: string;
  org: string;
  source: string;
  bullets: RewrittenBullet[];
  acceptedCount: number;
  canonicalFallbackCount: number;
  /** Present in `agent` mode: what to rewrite and which figures are protected. */
  workOrder: {
    instructions: string;
    perBulletChars: number;
    targetRole: string;
    atsKeywords: string[];
    bullets: Array<{
      bulletId: string;
      canonical: string;
      locked: boolean;
      protectedMetrics: string[];
    }>;
  } | null;
  notices: string[];
}

/**
 * One submitted draft after verification against its canonical bullet.
 * Mirrors the per-bullet payload of `resume_rewrite_bullets`.
 */
export interface VerifiedBullet {
  bulletId: string;
  /** The user's verified text; always the fallback. */
  canonical: string;
  /** What will actually be used: the draft when verified, else canonical. */
  accepted: string;
  status: "verified" | "rejected_canonical_fallback" | "canonical_only";
  /** True only when a supplied draft survived every check. */
  provenanceVerified: boolean;
  rejectionReasons?: string[];
  droppedMetrics?: string[];
  introducedNumbers?: string[];
}

/** Result of submitting drafts to `resume_rewrite_bullets`. */
export interface VerifyResult {
  blockId: string;
  title?: string;
  org?: string;
  bullets: VerifiedBullet[];
  verifiedCount: number;
  rejectedCount: number;
  /** Present when no drafts were supplied: what to rewrite and what is protected. */
  targetKeywords?: string[];
  guidance?: string;
}

export interface CompileReport {
  success: boolean;
  pageCount: number;
  errors: unknown[];
  warnings: unknown[];
  durationMs: number;
  byteLength: number;
}

export interface SynthesisResult {
  personaId: string;
  source: string;
  /** `"none"` for local providers. */
  externalTokenCost: string;
  profile: JDProfile;
  typstSource: string;
  compile: CompileReport;
  pdfBase64: string | null;
  matchReport: {
    coveragePercentage: number | null;
    mustHaveTotal: number;
    mustHaveCovered: number;
    uncoveredMustHaves: string[];
    selectedBlockCount: number;
    totalBullets: number;
    /** Measured, never assumed. */
    aiRewrittenCount: number;
    canonicalFallbackCount: number;
    fallbacks: Array<{
      blockId: string;
      bulletId: string;
      reason: FallbackReason;
      droppedMetrics: string[];
    }>;
    semanticMatchingDisabled: boolean;
    budgetViolations: string[];
    notices: string[];
    elapsedMs: number;
  };
  selectedBlocks: ScoredBlockSummary[];
}

/**
 * The résumé engine is Typst only. The LaTeX résumé path (`ats-*` templates,
 * `latex-escape.ts`, the bisect/repair loop) was removed; `latex.rs` still
 * serves the separate document-editor feature.
 */
export interface CompileResult extends CompileReport {
  engine: "typst";
  pdfBase64: string | null;
}

export class CareerResumeBridge {
  constructor(private client: StatelessMcpClient = defaultMcpClient) {}

  /**
   * Search candidate's career knowledgebase and experience blocks.
   */
  async searchKnowledgebase(
    query: string,
    options?: { persona?: string; kind?: string },
  ) {
    return this.client.callTool("career_search_kb", {
      query,
      persona: options?.persona,
      kind: options?.kind,
    });
  }

  /**
   * Analyze target job description to extract structured requirements.
   */
  async analyzeJobDescription(
    jdText: string,
    language?: LanguageOption,
  ): Promise<JDAnalysis> {
    return this.client.callTool<JDAnalysis>("resume_analyze_jd", {
      jd_text: jdText,
      language,
    }) as Promise<JDAnalysis>;
  }

  /**
   * Perform gap analysis comparing candidate's career blocks against JD.
   */
  async runGapAnalysis(
    jdText: string,
    personaId?: string,
    language?: LanguageOption,
  ): Promise<GapReport> {
    return this.client.callTool<GapReport>("resume_gap_analysis", {
      jd_text: jdText,
      persona_id: personaId,
      language,
    }) as Promise<GapReport>;
  }

  /**
   * Score blocks and select optimal set within strict page line budget.
   */
  async scoreAndSelectBlocks(
    jdText: string,
    options?: {
      personaId?: string;
      pageBudget?: number;
      maxBulletsPerBlock?: number;
      language?: LanguageOption;
    },
  ): Promise<SelectionReport> {
    return this.client.callTool<SelectionReport>("resume_score_and_select", {
      jd_text: jdText,
      persona_id: options?.personaId,
      page_budget: options?.pageBudget ?? 1,
      max_bullets_per_block: options?.maxBulletsPerBlock,
      language: options?.language,
    }) as Promise<SelectionReport>;
  }

  /**
   * Tailor experience block bullets with strict anti-hallucination provenance.
   */
  async rewriteBullets(
    blockId: string,
    jdText: string,
    options?: {
      bulletIds?: string[];
      perBulletChars?: number;
      language?: LanguageOption;
    },
  ): Promise<RewriteResult> {
    return this.client.callTool<RewriteResult>("resume_rewrite_bullets", {
      block_id: blockId,
      jd_text: jdText,
      bullet_ids: options?.bulletIds,
      per_bullet_chars: options?.perBulletChars,
      language: options?.language,
    }) as Promise<RewriteResult>;
  }

  /**
   * Submit agent-written bullet drafts for verification against the
   * knowledgebase (`resume_rewrite_bullets`).
   *
   * This is the gate that makes agent-driven rewriting safe: a draft is
   * accepted only if every ground-truth metric survives, no new figure is
   * introduced, the bullet is not locked, and it keeps meaningful overlap with
   * the canonical text. Rejected drafts come back with the canonical text and
   * the rejection reasons.
   *
   * Called without drafts this returns the canonical bullets and target
   * keywords as a work order — nothing was verified, so `provenanceVerified`
   * is false on every entry.
   */
  async verifyRewriteDrafts(
    blockId: string,
    jdText: string,
    drafts: Array<{ bulletId: string; text: string }>,
    bulletIds?: string[],
  ): Promise<VerifyResult> {
    return this.client.callTool<VerifyResult>("resume_rewrite_bullets", {
      block_id: blockId,
      jd_text: jdText,
      ...(drafts.length > 0 ? { drafts } : {}),
      ...(bulletIds && bulletIds.length > 0 ? { bullet_ids: bulletIds } : {}),
    }) as Promise<VerifyResult>;
  }

  /**
   * Execute full 7-stage resume synthesis pipeline asynchronously with live progress.
   */
  async synthesizeResumeAsync(
    jdText: string,
    options?: {
      personaId?: string;
      pageBudget?: number;
      header?: {
        name?: string;
        email?: string;
        phone?: string;
        location?: string;
        links?: string[];
      };
      summary?: string;
      includePdf?: boolean;
      language?: LanguageOption;
      onProgress?: (progress: number, message?: string) => void;
    },
  ): Promise<SynthesisResult> {
    const taskInit = (await this.client.callTool<{
      taskId: string;
      status: string;
    }>("resume_synthesize", {
      jd_text: jdText,
      persona_id: options?.personaId,
      page_budget: options?.pageBudget,
      header: options?.header,
      summary: options?.summary,
      include_pdf: options?.includePdf,
      language: options?.language,
      async: true,
    })) as { taskId?: string; status?: string };

    // Only the `async: true` branch returns a `taskId`; the other branch returns
    // the finished `SynthesisResult`. Casting blindly and polling meant that any
    // path where `async` did not survive threw
    // `MCP Error [-32602]: Missing required 'taskId' parameter` *after* a full
    // pipeline had already produced the résumé, throwing the result away.
    if (!taskInit?.taskId) {
      return taskInit as unknown as SynthesisResult;
    }

    return this.client.waitForTask<SynthesisResult>(taskInit.taskId, {
      onProgress: options?.onProgress,
    });
  }

  /**
   * Compile Typst resume source using the in-process Typst engine.
   *
   * PDF bytes are opt-in (`includePdf`, default false): the server reports
   * `pageCount`, diagnostics, and `pdfOmitted` instead of flooding the
   * context with base64. Pass true only when the bytes are actually needed.
   */
  async compileTypstResume(
    typstSource: string,
    includePdf = false,
  ): Promise<CompileResult> {
    return this.client.callTool<CompileResult>("resume_compile", {
      typst_source: typstSource,
      include_pdf: includePdf,
    }) as Promise<CompileResult>;
  }

  /**
   * Analyze one bullet against the X-Y-Z formula and the JD's keywords.
   *
   * Analysis only — it never rewrites the bullet and never supplies a metric.
   * The previous implementation appended a fabricated
   * "(impact: improved latency/efficiency by 25%)" to any bullet without a
   * number, which is precisely the hallucination the pipeline exists to
   * prevent. Use `rewriteBullets` or `verifyRewriteDrafts` to change text.
   */
  async fineTuneBullet(
    bulletText: string,
    jdText: string,
    perBulletChars?: number,
  ) {
    return this.client.callTool("resume_finetune_bullet", {
      bullet_text: bulletText,
      jd_text: jdText,
      per_bullet_chars: perBulletChars,
    });
  }

  /**
   * Delete an experience block, with MRTR confirmation.
   *
   * Call once with no `confirmation` to get an {@link InputRequiredResult} (use
   * `isInputRequired` to narrow it), show its `inputRequests` to the user, then
   * call again passing back the **exact** `requestState` you received along with
   * the answer.
   *
   * The two used to be independent parameters (`confirm = false`,
   * `requestState?`), which invited `deleteBlockSafely(id, true)` — a call the
   * server ignores entirely, because it only reads `input_responses` when a
   * `request_state` is present. Pairing them makes that shape unrepresentable.
   */
  async deleteBlockSafely(
    blockId: string,
    confirmation?: { requestState: string; confirm: boolean },
  ): Promise<unknown | InputRequiredResult> {
    return this.client.callTool(
      "career_delete_block",
      { block_id: blockId },
      confirmation
        ? {
            inputResponses: { confirm: confirmation.confirm },
            requestState: confirmation.requestState,
          }
        : undefined,
    );
  }
}

export const careerBridge = new CareerResumeBridge();
