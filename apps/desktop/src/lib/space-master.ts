import type { SpaceKind } from "@/lib/space-features";

/** Primary context file name to scaffold for each space kind. */
export function masterFileNameForKind(kind: SpaceKind): string {
  switch (kind) {
    case "resume":
      return "RESUME.md";
    case "statements":
      return "MASTER.md";
    default:
      return "MASTER.md";
  }
}

const MASTER_STUBS: Record<SpaceKind, string> = {
  resume: `# Resume master profile

The agent reads this file automatically. Fill in your real details — do not
invent roles or metrics.

## Contact
- Name:
- Location:
- Email:
- Phone:
- LinkedIn / portfolio:

## Target roles
- Titles or levels you are aiming for:
- Industries:

## Experience
<!-- One block per role: company, title, dates, rough bullets (truthful). -->

## Education

## Skills & tools

## Projects (optional)

## Preferences
- Page limit (default: 1 page):
- Sections to always include:
- Tone (concise / technical / leadership):
`,
  manuscript: `# Manuscript master profile

Project-level context for papers in this space. The agent reads this automatically.

## Working title

## Target venue or stage
- Journal / conference:
- Article type:
- Page or word limits:

## Authors & affiliations

## Contribution (one paragraph)

## Key claims & findings

## Conventions
- Citation style:
- Figure folder:
- Shared notation:
`,
  statements: `# Statement master profile

Background the agent uses across program-specific tailored versions. Stay truthful.

## Your path (2–3 defining experiences)

## Research or career goals

## Why graduate school / this field

## Strengths to emphasize

## Constraints
- Default word limit if none in a prompt:
- Programs or themes you are targeting:

## Do not invent
List credentials only you have confirmed above.
`,
  report: `# Report master profile

Audience, scope, and conventions for reports in this space.

## Report purpose

## Primary audience

## Executive summary themes (3 bullets max)

## Scope & exclusions

## Data sources

## Tone & length
`,
  general: `# Project master profile

Optional context the agent reads automatically at the start of each task.

## Purpose

## Audience

## Key facts & constraints

## Conventions
`,
};

export function masterStubForKind(kind: SpaceKind): string {
  return MASTER_STUBS[kind];
}
