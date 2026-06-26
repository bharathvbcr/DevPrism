import type { VariantStatusMeta } from "@/lib/variant-status";

/** Deliverable type that drives which workspace features appear. */
export type SpaceKind =
  | "resume"
  | "manuscript"
  | "statements"
  | "report"
  | "general";

type SpaceLike = {
  name: string;
  description: string;
  icon: string | null;
  kind?: SpaceKind;
};

export type SpaceQuickActionHandler = "create-cover-letter";

export interface SpaceQuickAction {
  id: string;
  label: string;
  title: string;
  prompt: string;
  /** Runs a built-in action instead of seeding the chat composer. */
  handler?: SpaceQuickActionHandler;
}

export interface SpaceVariantLabels {
  panelTitle: string;
  masterLabel: string;
  switchTitle: string;
  createAction: string;
  createDialogTitle: string;
  createDialogDescription: string;
  versionNamePlaceholder: string;
  targetLabel: string;
  targetHint: string;
  targetPlaceholder: string;
  targetMenuItem: string;
  targetDialogTitle: string;
  targetDialogDescription: string;
  tailorWithAi: string;
  tailorButtonTitle: string;
  overviewTitle: string;
  overviewEmpty: string;
  overviewEmptyCta: string;
  overviewColumnTarget: string;
}

export interface SpaceFeatureConfig {
  kind: SpaceKind;
  label: string;
  description: string;
  /** Show the tailored-versions switcher for projects in this space. */
  variants: boolean;
  variantLabels: SpaceVariantLabels;
  statuses: VariantStatusMeta[];
  tailorPrompt: string;
  quickActions: SpaceQuickAction[];
}

/** Bundled skill folder names to install for each space type (`latex-toolkit` is
 * always included for typed spaces). Empty = install the full bundle. */
export const BUNDLED_SKILLS_FOR_KIND: Record<SpaceKind, string[] | null> = {
  resume: ["resume-cv", "latex-toolkit"],
  manuscript: ["manuscript-paper", "latex-toolkit"],
  statements: ["statement-authoring", "latex-toolkit"],
  report: ["latex-toolkit"],
  general: null,
};

const RESUME_STATUSES: VariantStatusMeta[] = [
  { value: "draft", label: "Draft", color: "#94a3b8" },
  { value: "applied", label: "Applied", color: "#0ea5e9" },
  { value: "interview", label: "Interview", color: "#a855f7" },
  { value: "offer", label: "Offer", color: "#10b981" },
  { value: "rejected", label: "Rejected", color: "#ef4444" },
  { value: "archived", label: "Archived", color: "#64748b" },
];

const MANUSCRIPT_STATUSES: VariantStatusMeta[] = [
  { value: "draft", label: "Draft", color: "#94a3b8" },
  { value: "submitted", label: "Submitted", color: "#0ea5e9" },
  { value: "under-review", label: "Under review", color: "#a855f7" },
  { value: "revision", label: "Revision", color: "#f59e0b" },
  { value: "accepted", label: "Accepted", color: "#10b981" },
  { value: "rejected", label: "Rejected", color: "#ef4444" },
  { value: "archived", label: "Archived", color: "#64748b" },
];

const STATEMENT_STATUSES: VariantStatusMeta[] = [
  { value: "draft", label: "Draft", color: "#94a3b8" },
  { value: "submitted", label: "Submitted", color: "#0ea5e9" },
  { value: "interview", label: "Interview", color: "#a855f7" },
  { value: "accepted", label: "Accepted", color: "#10b981" },
  { value: "rejected", label: "Rejected", color: "#ef4444" },
  { value: "archived", label: "Archived", color: "#64748b" },
];

const REPORT_STATUSES: VariantStatusMeta[] = [
  { value: "draft", label: "Draft", color: "#94a3b8" },
  { value: "review", label: "In review", color: "#a855f7" },
  { value: "final", label: "Final", color: "#10b981" },
  { value: "delivered", label: "Delivered", color: "#0ea5e9" },
  { value: "archived", label: "Archived", color: "#64748b" },
];

export const SPACE_KIND_OPTIONS: {
  kind: SpaceKind;
  label: string;
  description: string;
  defaultIcon: string;
}[] = [
  {
    kind: "resume",
    label: "Resume / Jobs",
    description: "Tailor a master resume per job description",
    defaultIcon: "briefcase",
  },
  {
    kind: "manuscript",
    label: "Manuscript",
    description: "Track submission versions per venue or call for papers",
    defaultIcon: "flask",
  },
  {
    kind: "statements",
    label: "Statements",
    description: "Tailor personal statements and SOPs per program prompt",
    defaultIcon: "graduation-cap",
  },
  {
    kind: "report",
    label: "Reports",
    description:
      "Manage report versions for different audiences or deliverables",
    defaultIcon: "file",
  },
  {
    kind: "general",
    label: "General",
    description: "Group projects without tailored-version workflows",
    defaultIcon: "layers",
  },
];

const CONFIGS: Record<SpaceKind, SpaceFeatureConfig> = {
  resume: {
    kind: "resume",
    label: "Resume / Jobs",
    description: "Tailor a master resume for each job description.",
    variants: true,
    statuses: RESUME_STATUSES,
    tailorPrompt:
      "Tailor this resume to the role described in JOB_DESCRIPTION.md. Revise the " +
      "relevant sections (summary, experience bullets, and skills) to align with " +
      "the job's requirements and keywords, keeping everything truthful and in my " +
      "existing LaTeX style. List the key changes you made at the end.",
    variantLabels: {
      panelTitle: "Tailored versions",
      masterLabel: "Master",
      switchTitle: "Switch tailored version",
      createAction: "Tailor for new JD…",
      createDialogTitle: "Tailor for a new job description",
      createDialogDescription:
        "Copies the master into a new tailored version. Edits there never touch your master.",
      versionNamePlaceholder: "e.g. Acme — Senior PM",
      targetLabel: "Job description",
      targetHint:
        "(optional — saved as JOB_DESCRIPTION.md so the AI can tailor against it)",
      targetPlaceholder: "Paste the job description here…",
      targetMenuItem: "Job description…",
      targetDialogTitle: "Job description",
      targetDialogDescription:
        'The target "{name}" is tailored for. Saved as JOB_DESCRIPTION.md in this version so the AI assistant can use it.',
      tailorWithAi: "Tailor with AI",
      tailorButtonTitle: "Tailor this version to its job description with AI",
      overviewTitle: "Applications",
      overviewEmpty: "No tailored versions yet.",
      overviewEmptyCta:
        "Tailor your master resume to a job description to start tracking applications.",
      overviewColumnTarget: "Job description",
    },
    quickActions: [
      {
        id: "match-jd",
        label: "Match JD",
        title: "Check this resume against the job description for keyword gaps",
        prompt:
          "Compare this resume against the job description in JOB_DESCRIPTION.md and report an " +
          "ATS-style match: which required skills, keywords, and qualifications are covered, which " +
          "are missing, and where I can truthfully add or rephrase to close the gaps. Don't edit " +
          "the files yet — just give me the gap analysis with concrete suggestions.",
      },
      {
        id: "new-cover-letter",
        label: "New cover letter",
        title: "Create COVER_LETTER.tex from the letter template",
        prompt: "",
        handler: "create-cover-letter",
      },
      {
        id: "bullet-count",
        label: "Bullet count",
        title:
          "Select bullets in the editor — use the toolbar stepper to merge or split",
        prompt:
          "In the main resume file, review each experience entry and recommend a bullet count (1–5) " +
          "that fits a one-page layout. For roles with too many bullets, say which to merge; for " +
          "sparse roles, suggest how to split. Don't edit yet — list recommendations per role.",
      },
      {
        id: "stronger-bullets",
        label: "Stronger bullets",
        title: "Rewrite weak experience bullets with action verbs and metrics",
        prompt:
          "Review every experience bullet in the main resume. Rewrite weak openers ('Responsible for', " +
          "'Worked on') into strong past-tense verbs, add measurable impact where facts are already implied, " +
          "and flag any bullet that needs a metric from me. Keep the same bullet count per role unless a " +
          "role clearly has too many — then say which to merge. List changes at the end.",
      },
      {
        id: "trim-one-page",
        label: "Trim to 1 page",
        title: "Suggest cuts to fit a one-page resume",
        prompt:
          "My resume should fit on one page. Review the main LaTeX file and recommend what to trim: which " +
          "roles to shorten, how many bullets per role, and whether Summary or older roles can be cut. " +
          "Prioritize keeping recent, high-impact experience. Don't edit yet — give me a prioritized plan.",
      },
      {
        id: "cover-letter",
        label: "Draft letter",
        title: "Draft a tailored cover letter as COVER_LETTER.tex with AI",
        prompt:
          "Draft a one-page cover letter for the role in JOB_DESCRIPTION.md, drawing on the " +
          "experience and achievements in this resume (and MASTER.md if present). If COVER_LETTER.tex " +
          "does not exist, create it using the letter document class with a professional structure. " +
          "If it exists, update it in place. Keep it specific and truthful, and mirror the job's language.",
      },
      {
        id: "quantify-bullets",
        label: "Quantify",
        title: "Strengthen experience bullets with measurable impact",
        prompt:
          "Review the experience bullets in the main resume file and rewrite weak ones to lead with " +
          "measurable impact (numbers, scope, outcomes) using strong action verbs. Only use facts " +
          "already implied by the resume — flag any bullet where you'd need a metric I haven't " +
          "provided. List the key changes at the end.",
      },
    ],
  },
  manuscript: {
    kind: "manuscript",
    label: "Manuscript",
    description: "Manage submission versions for different venues.",
    variants: true,
    statuses: MANUSCRIPT_STATUSES,
    tailorPrompt:
      "Adapt this manuscript for the venue or call for papers described in JOB_DESCRIPTION.md. " +
      "Adjust structure, length, abstract, keywords, and formatting requirements while keeping " +
      "the scientific content accurate. Note any class or style changes needed for the target venue " +
      "and list the main edits at the end.",
    variantLabels: {
      panelTitle: "Submission versions",
      masterLabel: "Master",
      switchTitle: "Switch submission version",
      createAction: "New submission version…",
      createDialogTitle: "Create a submission version",
      createDialogDescription:
        "Copies the master manuscript into a venue-specific version. Your master stays untouched.",
      versionNamePlaceholder: "e.g. Nature Methods — Methods article",
      targetLabel: "Venue / call for papers",
      targetHint:
        "(optional — saved as JOB_DESCRIPTION.md so the AI can adapt against it)",
      targetPlaceholder:
        "Paste the journal guidelines, CFP, or submission requirements…",
      targetMenuItem: "Venue requirements…",
      targetDialogTitle: "Venue requirements",
      targetDialogDescription:
        'Submission target for "{name}". Saved as JOB_DESCRIPTION.md so the AI assistant can use it.',
      tailorWithAi: "Adapt with AI",
      tailorButtonTitle: "Adapt this version to its venue requirements with AI",
      overviewTitle: "Submissions",
      overviewEmpty: "No submission versions yet.",
      overviewEmptyCta:
        "Create a version for a journal or conference to track each submission separately.",
      overviewColumnTarget: "Venue / requirements",
    },
    quickActions: [
      {
        id: "submission-checklist",
        label: "Checklist",
        title: "Generate a submission checklist for this manuscript",
        prompt:
          "Review this manuscript project and produce a submission checklist for the target " +
          "venue described in JOB_DESCRIPTION.md (or the project's MASTER.md if no target file " +
          "exists). Cover abstract length, figure resolution, reference style, anonymization, " +
          "supplementary files, and any class or formatting requirements.",
      },
      {
        id: "abstract-polish",
        label: "Polish abstract",
        title: "Polish the abstract for clarity and venue fit",
        prompt:
          "Polish the abstract in the main LaTeX file for clarity, concision, and fit with the " +
          "venue requirements in JOB_DESCRIPTION.md. Keep it within typical journal limits and " +
          "preserve the scientific claims.",
      },
    ],
  },
  statements: {
    kind: "statements",
    label: "Statements",
    description: "Tailor personal statements and SOPs per program.",
    variants: true,
    statuses: STATEMENT_STATUSES,
    tailorPrompt:
      "Tailor this personal statement to the program prompt in JOB_DESCRIPTION.md. Align the " +
      "narrative with the question's themes while staying truthful to my background in MASTER.md " +
      "and the existing document. Keep the voice consistent and within any stated word limit. " +
      "List the key changes you made at the end.",
    variantLabels: {
      panelTitle: "Tailored statements",
      masterLabel: "Master",
      switchTitle: "Switch tailored statement",
      createAction: "Tailor for new prompt…",
      createDialogTitle: "Tailor for a new program prompt",
      createDialogDescription:
        "Copies the master statement into a program-specific version. Your master stays untouched.",
      versionNamePlaceholder: "e.g. Stanford CS — Prompt 1",
      targetLabel: "Program prompt / question",
      targetHint:
        "(optional — saved as JOB_DESCRIPTION.md so the AI can tailor against it)",
      targetPlaceholder:
        "Paste the essay prompt, SOP question, or program instructions…",
      targetMenuItem: "Program prompt…",
      targetDialogTitle: "Program prompt",
      targetDialogDescription:
        'The prompt "{name}" is tailored for. Saved as JOB_DESCRIPTION.md so the AI assistant can use it.',
      tailorWithAi: "Tailor with AI",
      tailorButtonTitle: "Tailor this version to its program prompt with AI",
      overviewTitle: "Applications",
      overviewEmpty: "No tailored statements yet.",
      overviewEmptyCta:
        "Create a version for each program prompt to track your applications separately.",
      overviewColumnTarget: "Program prompt",
    },
    quickActions: [
      {
        id: "tighten-statement",
        label: "Tighten",
        title: "Tighten the statement to fit word limits",
        prompt:
          "Tighten this personal statement to fit the word or character limit in JOB_DESCRIPTION.md " +
          "(or a reasonable graduate-school limit if none is given). Preserve the strongest " +
          "themes and cut repetition without changing the facts.",
      },
      {
        id: "opening-hook",
        label: "Opening hook",
        title: "Strengthen the opening paragraph",
        prompt:
          "Rewrite the opening paragraph of this personal statement to be more compelling and " +
          "specific, aligned with the program prompt in JOB_DESCRIPTION.md. Keep the rest of the " +
          "statement intact unless small transitions are needed.",
      },
    ],
  },
  report: {
    kind: "report",
    label: "Reports",
    description: "Manage versions for different audiences or deliverables.",
    variants: true,
    statuses: REPORT_STATUSES,
    tailorPrompt:
      "Adapt this report for the audience or brief described in JOB_DESCRIPTION.md. Adjust " +
      "tone, level of detail, emphasis, and structure while keeping facts accurate. Highlight " +
      "what should move to an executive summary vs. the main body and list the main edits.",
    variantLabels: {
      panelTitle: "Report versions",
      masterLabel: "Master",
      switchTitle: "Switch report version",
      createAction: "New audience version…",
      createDialogTitle: "Create a report version",
      createDialogDescription:
        "Copies the master report into an audience-specific version. Your master stays untouched.",
      versionNamePlaceholder: "e.g. Board — Q3 executive brief",
      targetLabel: "Audience / brief",
      targetHint:
        "(optional — saved as JOB_DESCRIPTION.md so the AI can adapt against it)",
      targetPlaceholder:
        "Paste the stakeholder brief, RFP excerpt, or audience requirements…",
      targetMenuItem: "Audience brief…",
      targetDialogTitle: "Audience brief",
      targetDialogDescription:
        'Audience or brief for "{name}". Saved as JOB_DESCRIPTION.md so the AI assistant can use it.',
      tailorWithAi: "Adapt with AI",
      tailorButtonTitle: "Adapt this version to its audience brief with AI",
      overviewTitle: "Deliverables",
      overviewEmpty: "No report versions yet.",
      overviewEmptyCta:
        "Create a version for each audience or deliverable to track revisions separately.",
      overviewColumnTarget: "Audience / brief",
    },
    quickActions: [
      {
        id: "executive-summary",
        label: "Summary",
        title: "Draft an executive summary from the report body",
        prompt:
          "Read the main report LaTeX file and draft a concise executive summary section. " +
          "Match the tone and priorities in JOB_DESCRIPTION.md if present. Insert or update " +
          "an Executive Summary section without removing technical detail from the main body.",
      },
      {
        id: "report-outline",
        label: "Outline",
        title: "Propose a report structure for the stated audience",
        prompt:
          "Propose a clear section outline for this report tailored to the audience in " +
          "JOB_DESCRIPTION.md (or a general technical audience if none is given). Map existing " +
          "content to sections and note gaps to fill.",
      },
    ],
  },
  general: {
    kind: "general",
    label: "General",
    description: "No tailored-version workflow.",
    variants: false,
    statuses: RESUME_STATUSES,
    tailorPrompt: "",
    variantLabels: {
      panelTitle: "Versions",
      masterLabel: "Master",
      switchTitle: "Switch version",
      createAction: "New version…",
      createDialogTitle: "New version",
      createDialogDescription: "",
      versionNamePlaceholder: "e.g. Client draft",
      targetLabel: "Target",
      targetHint: "",
      targetPlaceholder: "",
      targetMenuItem: "Target…",
      targetDialogTitle: "Target",
      targetDialogDescription: "",
      tailorWithAi: "Tailor with AI",
      tailorButtonTitle: "",
      overviewTitle: "Versions",
      overviewEmpty: "No versions yet.",
      overviewEmptyCta: "",
      overviewColumnTarget: "Target",
    },
    quickActions: [
      {
        id: "proofread-doc",
        label: "Proofread",
        title: "Proofread the active document for grammar and clarity",
        prompt:
          "Proofread the main LaTeX file for grammar, spelling, and clarity. Fix issues in place with the Edit tool and list the key changes at the end.",
      },
      {
        id: "improve-flow",
        label: "Improve flow",
        title: "Improve transitions and paragraph flow",
        prompt:
          "Review the main document for flow and transitions between sections. Suggest or apply concise improvements while preserving meaning and LaTeX structure.",
      },
      {
        id: "summarize",
        label: "Summarize",
        title: "Summarize the document in a short paragraph",
        prompt:
          "Read the main LaTeX file and write a concise summary of its content and purpose. Do not edit the file — just provide the summary.",
      },
    ],
  },
};

export function isSpaceKind(value: string): value is SpaceKind {
  return (
    value === "resume" ||
    value === "manuscript" ||
    value === "statements" ||
    value === "report" ||
    value === "general"
  );
}

/** Guess a space kind from its name/description when older spaces lack `kind`. */
export function inferSpaceKind(space: SpaceLike): SpaceKind {
  if (space.kind && isSpaceKind(space.kind)) return space.kind;

  const haystack = `${space.name} ${space.description}`.toLowerCase();
  if (
    /\b(resume|resumes|cv|cvs|job|jobs|application|applications|career)\b/.test(
      haystack,
    )
  ) {
    return "resume";
  }
  if (
    /\b(manuscript|manuscripts|paper|papers|thesis|research|journal|conference|publication)\b/.test(
      haystack,
    )
  ) {
    return "manuscript";
  }
  if (
    /\b(statement|statements|sop|personal statement|admissions|graduate|fellowship|motivation letter)\b/.test(
      haystack,
    )
  ) {
    return "statements";
  }
  if (
    /\b(report|reports|brief|briefs|memo|memos|whitepaper|whitepapers|deliverable)\b/.test(
      haystack,
    )
  ) {
    return "report";
  }
  if (space.icon === "briefcase") return "resume";
  if (space.icon === "flask" || space.icon === "book") return "manuscript";
  if (space.icon === "graduation-cap") return "statements";
  if (space.icon === "file") return "report";
  return "general";
}

/** Infer deliverable type from a project folder name when no space is assigned. */
export function inferSpaceKindFromProjectPath(projectPath: string): SpaceKind {
  const base =
    projectPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? projectPath;
  return inferSpaceKind({ name: base, description: "", icon: null });
}

export function spaceFeatureConfig(
  space: SpaceLike | null | undefined,
): SpaceFeatureConfig {
  const kind = space ? inferSpaceKind(space) : "general";
  return CONFIGS[kind];
}

export function spaceKindLabel(kind: SpaceKind): string {
  return SPACE_KIND_OPTIONS.find((o) => o.kind === kind)?.label ?? kind;
}

export function bundledSkillsForKind(kind: SpaceKind): string[] | null {
  return BUNDLED_SKILLS_FOR_KIND[kind];
}

/** Template ids surfaced first when creating from a filtered space. */
export const RECOMMENDED_TEMPLATE_IDS: Record<SpaceKind, string[]> = {
  resume: ["cv-modern", "letter-formal", "blank"],
  manuscript: ["paper-standard", "paper-ieee", "paper-acm", "thesis-standard"],
  statements: ["letter-formal", "blank"],
  report: ["report-technical", "report-scientific", "blank"],
  general: [],
};

export function recommendedTemplateIdsForKind(kind: SpaceKind): string[] {
  return RECOMMENDED_TEMPLATE_IDS[kind] ?? [];
}

export function statusMetaForSpace(
  config: SpaceFeatureConfig,
  status: string,
): VariantStatusMeta {
  return config.statuses.find((s) => s.value === status) ?? config.statuses[0];
}
