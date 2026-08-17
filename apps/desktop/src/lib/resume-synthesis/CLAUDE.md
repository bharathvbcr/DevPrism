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
- Compile failure is reported, never repaired: Typst slot text cannot break compilation, so a failure means a template/engine defect
- Backends: selected chat provider (Ollama / OpenAI-compat / Claude Code / Cursor) via `resolveAiProvider` → `ai_complete`; embeddings stay Ollama/cloud
- Templates: `apps/desktop/src/lib/resume-templates/`; career DB: `apps/desktop/src/lib/career/`
- **Engine**: Typst only (`career_typst_compile`, ~0.6ms warm). The LaTeX resume path — `ats-*` templates, `latex-escape.ts`, the bisect/repair loop, `career_verify_compile` — was **removed**. Use `renderResume` / `compileResumeDocument`
- Legacy ids: `canonicalTemplateId` maps `ats-single-column` / `ats-two-column` onto Typst; personas are migrated on DB open (`migrate_persona_templates`)
- `RenderedBlock.location` / `url` / `urlLabel` / `extra` (GPA, honors) come from `ExperienceBlock` via `draftsToContent` — these were unmapped and therefore unreachable before; keep the mapping when touching that function
- `MatchReport.repairs` is legacy-only (pre-Typst runs); nothing writes it
- Typst text safety: `typst-escape.ts` emits **code-mode string literals** only; the body is one `#{ … }` block (`typst-ats.ts`, `assertCodeModeOnly`). Injection is impossible by construction, so the Typst path has **no bisect/repair loop**
- Regenerate cross-language fixtures with `npx vitest run src/__tests__/lib/typst-fixtures.emit.test.ts`; the Rust test `rendered_fixtures_compile` compiles them
- Progress store: `apps/desktop/src/stores/synthesis-store.ts` (`openStoredReport` for run history + tex)

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
