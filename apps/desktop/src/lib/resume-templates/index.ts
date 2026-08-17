export type {
  HeaderFields,
  RenderedBlock,
  RenderResult,
  ResumeContent,
  ResumeEngine,
  ResumeTemplate,
  ResumeTemplateBudget,
  ResumeTemplateLayout,
  SectionKind,
  SectionSlot,
  SkillGroup,
  SlotLineRange,
} from "./types";

export {
  TYPST_ATS_PREAMBLE,
  TYPST_ATS_SINGLE_TEMPLATE,
  TYPST_ATS_TWO_COLUMN_TEMPLATE,
  assertCodeModeOnly,
  renderTypstTemplate,
  typstBodyLines,
} from "./typst-ats";

import {
  TYPST_ATS_SINGLE_TEMPLATE,
  TYPST_ATS_TWO_COLUMN_TEMPLATE,
} from "./typst-ats";
import type {
  RenderResult,
  ResumeContent,
  ResumeEngine,
  ResumeTemplate,
  SectionKind,
} from "./types";

const TEMPLATE_REGISTRY: Record<string, ResumeTemplate> = {
  [TYPST_ATS_SINGLE_TEMPLATE.id]: TYPST_ATS_SINGLE_TEMPLATE,
  [TYPST_ATS_TWO_COLUMN_TEMPLATE.id]: TYPST_ATS_TWO_COLUMN_TEMPLATE,
};

/**
 * Resume templates removed when Typst replaced LaTeX as the resume engine.
 *
 * Personas are migrated on career-DB open (`migrate_persona_templates`), but a
 * stored run, an in-flight UI selection, or a hand-edited setting can still
 * carry a legacy id. Mapping them keeps Synthesize working instead of failing
 * with "Unknown resume template".
 */
const LEGACY_TEMPLATE_IDS: Record<string, string> = {
  "ats-single-column": TYPST_ATS_SINGLE_TEMPLATE.id,
  "ats-two-column": TYPST_ATS_TWO_COLUMN_TEMPLATE.id,
};

/** Current id for a possibly-legacy template id. */
export function canonicalTemplateId(id: string): string {
  return LEGACY_TEMPLATE_IDS[id] ?? id;
}

/** True when `id` names a template from the removed LaTeX resume engine. */
export function isLegacyLatexTemplateId(id: string): boolean {
  return id in LEGACY_TEMPLATE_IDS;
}

export function getResumeTemplate(id: string): ResumeTemplate | undefined {
  return TEMPLATE_REGISTRY[canonicalTemplateId(id)];
}

export function listResumeTemplates(): ResumeTemplate[] {
  return Object.values(TEMPLATE_REGISTRY);
}

/** A template's engine. Every registered template is Typst. */
export function templateEngine(template: ResumeTemplate): ResumeEngine {
  return template.engine ?? "typst";
}

/** Assemble a document from a template. */
export function renderResume(
  template: ResumeTemplate,
  content: ResumeContent,
  sectionOrder?: SectionKind[],
): RenderResult {
  if (!template.render) {
    throw new Error(
      `Resume template "${template.id}" has no renderer registered.`,
    );
  }
  return template.render(content, sectionOrder);
}
