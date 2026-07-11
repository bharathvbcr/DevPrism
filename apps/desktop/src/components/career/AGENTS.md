# Career UI

React surface for the Master Career Database (blocks, personas, import wizard)
and the Synthesize wizard (JD → match report → variant materialization).

## Repo Map

- Canonical map: `../../../../docs/GITNEXUS_MAP.md`
- Client/types: `apps/desktop/src/lib/career/`
- Synthesis: `apps/desktop/src/lib/resume-synthesis/` (+ `materialize.ts`)
- Synthesize tab UX: per-block rewrite checklist, live stream preview (rewrite + JD analysis + critic), coverage heatmap, Runs panel (`listRuns`), pipeline timings, Cancel (mid-LLM via AbortSignal → `ai_cancel_request`), rematerialize stored `.tex`
- Knowledge / Database: `ProcessingProgress` via `ingest-progress.tsx` (per-file ingest, embed-all, import commit)
- BibTeX: KB chunk ingest (paste / `.bib` files) vs publication blocks via `publication-import-wizard.tsx` → `commitBlocks`
- Stores: `apps/desktop/src/stores/career-store.ts`, `synthesis-store.ts` (`cancel`, `openStoredReport` with tex)
- App branch: `apps/desktop/src/App.tsx`

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
