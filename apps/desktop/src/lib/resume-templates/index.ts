export type {
  HeaderFields,
  RenderedBlock,
  RenderResult,
  ResumeContent,
  ResumeTemplate,
  ResumeTemplateBudget,
  ResumeTemplateLayout,
  SectionKind,
  SectionSlot,
  SkillGroup,
  SlotLineRange,
} from "./types";

export {
  ATS_RESUME_PREAMBLE,
  ATS_RESUME_TEMPLATE,
  renderTemplate,
  setSlotPlainText,
} from "./ats-single-column";

export {
  ATS_TWO_COLUMN_PREAMBLE,
  ATS_TWO_COLUMN_TEMPLATE,
} from "./ats-two-column";

import { ATS_RESUME_TEMPLATE } from "./ats-single-column";
import { ATS_TWO_COLUMN_TEMPLATE } from "./ats-two-column";
import type { ResumeTemplate } from "./types";

const TEMPLATE_REGISTRY: Record<string, ResumeTemplate> = {
  [ATS_RESUME_TEMPLATE.id]: ATS_RESUME_TEMPLATE,
  [ATS_TWO_COLUMN_TEMPLATE.id]: ATS_TWO_COLUMN_TEMPLATE,
};

export function getResumeTemplate(id: string): ResumeTemplate | undefined {
  return TEMPLATE_REGISTRY[id];
}

export function listResumeTemplates(): ResumeTemplate[] {
  return Object.values(TEMPLATE_REGISTRY);
}
