# Career UI

React surface for the Master Career Database (blocks, personas, Fact Pool, import wizards)
and the Synthesize wizard (JD → match report → variant materialization).

## Repo Map

- Canonical map: `../../../../docs/GITNEXUS_MAP.md`
- Design: `docs/CAREER_PLATFORM_DESIGN.md`, `docs/RESUME_SYNTHESIS.md`
- Client/types: `apps/desktop/src/lib/career/` (Fact Pool, `distill-facts.ts`)
- Synthesis: `apps/desktop/src/lib/resume-synthesis/` (+ `materialize.ts`, `gap-analysis.ts`, `preflight.ts`)
- Synthesize tab (`synthesize/`): `PipelineBoard` (always-visible idle/live/done + run-blocked explainer), `AiReadinessCard` (skeleton while probing), `KnowledgePanel`, `AddKnowledgeDialog` (documents + **Quick points**), `RunProgressView`, `RunResults` (before/after diffs, provenance chips, “What’s missing” gap panel), runs history
- Block editor: “Knowledge / raw points” + Distill with AI preview before save
- Knowledge / Database: `ProcessingProgress` via `ingest-progress.tsx` (per-file ingest, embed-all, import commit)
- BibTeX: KB chunk ingest (paste / `.bib` files) vs publication blocks via `publication-import-wizard.tsx` → `commitBlocks`
- Stores: `apps/desktop/src/stores/career-store.ts` (`openCareer` remembers last tab), `synthesis-store.ts` (`cancel`, `openStoredReport` with tex; auto-open latest idle run)
- App branch: `apps/desktop/src/App.tsx`

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
