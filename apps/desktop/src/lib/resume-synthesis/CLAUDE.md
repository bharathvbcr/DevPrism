# Resume synthesis (TypeScript)

JD → hybrid scoring → knapsack selection → gap analysis → evidence (KB + facts) → distill/rewrite → critic → slot assembly + compile-verify.

## Repo Map

- Canonical map: `../../../../docs/GITNEXUS_MAP.md`
- Design: `docs/CAREER_PLATFORM_DESIGN.md`, `docs/RESUME_SYNTHESIS.md`
- Orchestrator: `orchestrator.ts`; stages: `jd-analysis.ts`, `scoring.ts`, `selection.ts` (knapsack + bullet trim + MMR), `gap-analysis.ts` (stage 3b), `rewrite.ts` (distill + provenance), `critic.ts`
- MatchReport extras: `stageTimingsMs`, `mustHaveCoverage`, `gapAnalysis`, `bulletProvenance`, `blockFacts`, `blockEvidence`, optional `blockDiffs`; persisted runs include `tex` for rematerialization
- UX helpers: `synthesis-ux.ts` (coverage heat levels, stage timing list, stream preview extract, stored-run parse + `extractStoredRunTex`); readiness: `preflight.ts`
- Rewrite/distill: prefers `streamComplete` (`ai_complete_stream`) with `llmJson` fallback; cites `sourceFactIds` / `sourceBulletId`; may distill fact-only bullets; emits `blockProgress` on stage 5
- Stage 4: KB MMR evidence + ranked facts (`ownerKind: "fact"` cosine + must-have boost) → stage 5
- JD analysis + critic: also stream via `llmJson` `streamComplete` / `onStreamPreview` → `SynthesisStage.streamPreview`
- Cancellation: `AbortSignal` on `synthesizeResume`; `aiComplete`/`aiCompleteStream`/`llmJson` honor signal + `ai_cancel_request`; store `cancel()` → stage `cancelled`
- Compile soft-fail: exhausted `compileWithRepairLoop` retries return `success: false` draft (orchestrator "Compile needs review") instead of throwing
- Backends: selected chat provider (Ollama / OpenAI-compat / Claude Code / Cursor) via `resolveAiProvider` → `ai_complete`; embeddings stay Ollama/cloud
- Templates: `apps/desktop/src/lib/resume-templates/`; career DB: `apps/desktop/src/lib/career/`
- Progress store: `apps/desktop/src/stores/synthesis-store.ts` (`openStoredReport` for run history + tex)

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
