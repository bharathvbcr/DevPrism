/** Section kinds supported by slot-based resume templates. */
export type SectionKind =
  | "header"
  | "summary"
  | "skills"
  | "experience"
  | "projects"
  | "education"
  | "publications"
  | "leadership";

/** One experience/project/education entry after rewrite (plain text only). */
export interface RenderedBlock {
  id: string;
  title: string;
  org: string;
  location?: string;
  /** Display date range, e.g. "Jan 2022 -- Present". */
  dateRange: string;
  url?: string;
  urlLabel?: string;
  /** Current (possibly AI-rewritten) bullet texts. */
  bullets: string[];
  /**
   * Ground-truth bullets for compile-verify fallback.
   * Defaults to `bullets[i]` when omitted.
   */
  canonicalBullets?: string[];
  /** Optional trailing line (GPA, honors, coursework). */
  extra?: string;
  /** Canonical form of `extra` for compile fallback. */
  canonicalExtra?: string;
}

export interface SkillGroup {
  label: string;
  /** Comma-separated skill names (plain text). */
  items: string;
}

export interface HeaderFields {
  fullName: string;
  cityRegion: string;
  email: string;
  phone: string;
  linkedinUrl?: string;
  linkedinLabel?: string;
  githubUrl?: string;
  githubLabel?: string;
  portfolioUrl?: string;
  portfolioLabel?: string;
}

export interface ResumeContent {
  header: HeaderFields;
  summary?: string;
  /** Canonical summary for compile-verify fallback. */
  canonicalSummary?: string;
  skills?: SkillGroup[];
  experience: RenderedBlock[];
  projects?: RenderedBlock[];
  education?: RenderedBlock[];
  publications?: RenderedBlock[];
  leadership?: RenderedBlock[];
}

/**
 * Line range (1-based, inclusive) for a filled slot in the rendered `.tex`.
 * Used by the compile-verify repair loop to map engine errors back to content.
 */
export interface SlotLineRange {
  /** Stable id, e.g. `experience:exp_1:bullet:0` or `summary`. */
  slotId: string;
  kind: SectionKind;
  startLine: number;
  endLine: number;
  /** Plain-text canonical fallback for this slot (pre-escape). */
  canonical: string;
  /** Current plain-text value that was escaped into the slot. */
  current: string;
}

export interface SectionSlot {
  kind: SectionKind;
  /** Typed renderer — only escaped strings may be interpolated. */
  render: (blocks: RenderedBlock[]) => string;
}

/**
 * Typesetting backend a template compiles with.
 *
 * Only `typst` is used for resumes — it links the compiler in-process (see
 * `career_typst_compile`). `latex` remains for the general document workspace,
 * which compiles via Tectonic, and for reading pre-Typst stored runs.
 */
export type ResumeEngine = "latex" | "typst";

export interface ResumeTemplateBudget {
  totalLines: number;
  perBullet: number;
  blocksPerSection: Partial<Record<SectionKind, number>>;
}

/** Body layout after the full-width header. Default: single-column. */
export type ResumeTemplateLayout = "single-column" | "two-column";

export interface ResumeTemplate {
  id: string;
  /** Which compiler renders this template. Defaults to `latex` when absent. */
  engine?: ResumeEngine;
  /** Static, hand-audited preamble — never touched by AI. */
  preamble: string;
  sections: SectionSlot[];
  budget: ResumeTemplateBudget;
  /**
   * `two-column` places skills/education/leadership in a narrow left
   * minipage and summary/experience/projects/publications on the right.
   */
  layout?: ResumeTemplateLayout;
  /**
   * Engine-specific document assembly. When absent the LaTeX assembler
   * (`renderTemplate`) is used, preserving the pre-Typst behaviour.
   */
  render?: (
    content: ResumeContent,
    sectionOrder?: SectionKind[],
  ) => RenderResult;
  /** Typst only: font fallback chain. The last entry should be an embedded family. */
  fontStack?: string[];
  /** Typst only: page margin, e.g. `"0.7in"`. */
  pageMargin?: string;
  /** Typst only: base text size, e.g. `"11pt"`. */
  baseFontSize?: string;
}

export interface RenderResult {
  /**
   * Assembled document source — LaTeX for `engine: "latex"`, Typst markup
   * for `engine: "typst"`.
   */
  source: string;
  slots: SlotLineRange[];
}
