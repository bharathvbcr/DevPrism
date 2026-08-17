/**
 * DevPrism Career & Resume Bridge for Stateless MCP 2.0.
 *
 * High-level typed interfaces connecting UI components and AI agent workflows
 * to the Stateless MCP 2.0 backend.
 */

import { StatelessMcpClient, defaultMcpClient } from "./client";
import { InputRequiredResult } from "./types";

export interface JDProfile {
  title: string;
  company: string;
  requiredSkills: string[];
  preferredSkills: string[];
  seniority: string;
  domain: string;
  cultureKeywords: string[];
}

export interface GapReport {
  coveragePercentage: number;
  personaId: string;
  requiredSkillsTotal: number;
  requiredSkillsCovered: string[];
  requiredSkillsMissing: string[];
  preferredSkillsCovered: string[];
  preferredSkillsMissing: string[];
  warnings: string[];
  recommendedFocus: string;
}

export interface SynthesisResult {
  personaId: string;
  templateId: string;
  typstSource: string;
  pdfBytesLength: number;
  errors?: unknown[];
  warnings?: unknown[];
  pageCount?: number;
  matchReport: {
    coveragePercentage: number;
    aiRewrittenCount: number;
    canonicalFallbackCount: number;
  };
}

export interface CompileResult {
  engine: "typst" | "tectonic";
  success: boolean;
  errors?: unknown[];
  warnings?: unknown[];
  pageCount?: number;
  pdfBase64?: string;
  byteLength: number;
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
  async analyzeJobDescription(jdText: string): Promise<{ profile: JDProfile }> {
    return this.client.callTool<{ profile: JDProfile }>("resume_analyze_jd", {
      jd_text: jdText,
    }) as Promise<{ profile: JDProfile }>;
  }

  /**
   * Perform gap analysis comparing candidate's career blocks against JD.
   */
  async runGapAnalysis(jdText: string, personaId = "ai"): Promise<GapReport> {
    return this.client.callTool<GapReport>("resume_gap_analysis", {
      jd_text: jdText,
      persona_id: personaId,
    }) as Promise<GapReport>;
  }

  /**
   * Score blocks and select optimal set within strict page line budget.
   */
  async scoreAndSelectBlocks(
    jdText: string,
    options?: { personaId?: string; pageBudget?: number },
  ) {
    return this.client.callTool("resume_score_and_select", {
      jd_text: jdText,
      persona_id: options?.personaId,
      page_budget: options?.pageBudget || 1,
    });
  }

  /**
   * Tailor experience block bullets with strict anti-hallucination provenance.
   */
  async rewriteBullets(blockId: string, jdText: string, bulletIds?: string[]) {
    return this.client.callTool("resume_rewrite_bullets", {
      block_id: blockId,
      jd_text: jdText,
      bullet_ids: bulletIds,
    });
  }

  /**
   * Execute full 7-stage resume synthesis pipeline asynchronously with live progress.
   */
  async synthesizeResumeAsync(
    jdText: string,
    options?: {
      personaId?: string;
      templateId?: string;
      onProgress?: (progress: number, message?: string) => void;
    },
  ): Promise<SynthesisResult> {
    const taskInit = (await this.client.callTool<{
      taskId: string;
      status: string;
    }>("resume_synthesize", {
      jd_text: jdText,
      persona_id: options?.personaId || "ai",
      template_id: options?.templateId || "modern-cv",
      async: true,
    })) as { taskId: string; status: string };

    return this.client.waitForTask<SynthesisResult>(taskInit.taskId, {
      onProgress: options?.onProgress,
    });
  }

  /**
   * Compile Typst resume source into PDF bytes using the in-process Typst engine.
   */
  async compileTypstResume(typstSource: string): Promise<CompileResult> {
    return this.client.callTool<CompileResult>("resume_compile", {
      typst_source: typstSource,
    }) as Promise<CompileResult>;
  }

  /**
   * Fine-tune a single bullet point for Google X-Y-Z metric impact and JD alignment.
   */
  async fineTuneBullet(bulletText: string, jdText: string, context?: string) {
    return this.client.callTool("resume_finetune_bullet", {
      bullet_text: bulletText,
      jd_text: jdText,
      context,
    });
  }

  /**
   * Delete an experience block with MRTR safety elicitation.
   */
  async deleteBlockSafely(
    blockId: string,
    confirm = false,
    requestState?: string,
  ): Promise<unknown | InputRequiredResult> {
    return this.client.callTool(
      "career_delete_block",
      { block_id: blockId },
      {
        inputResponses: confirm ? { confirm: true } : undefined,
        requestState,
      },
    );
  }
}

export const careerBridge = new CareerResumeBridge();
