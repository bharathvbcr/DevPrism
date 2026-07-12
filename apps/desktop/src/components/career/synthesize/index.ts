/**
 * Synthesize tab components.
 *
 * Mount points:
 * - `AiReadinessCard` → top of `CareerSynthesizeTab` (preflight)
 * - `KnowledgePanel` → knowledge coverage + add CTA
 * - `AddKnowledgeDialog` → form / panel actions (kb-integration)
 * - `PipelineBoard` → always-visible stage board + run-blocked explainer
 * - `RunProgressView` → live/done activity (composed inside PipelineBoard)
 * - `BlockDiffCards` / `GapAnalysisPanel` / results / history → post-run UX
 */

export { AiReadinessCard } from "./ai-readiness-card";
export { AddKnowledgeDialog } from "./add-knowledge-dialog";
export { KnowledgePanel } from "./knowledge-panel";
export { PipelineBoard } from "./pipeline-board";
export { RunProgressView, SYNTHESIS_STAGE_ORDER } from "./run-progress-view";
export {
  BlockDiffCards,
  GapAnalysisPanel,
  LiveScoredBlocksTable,
  MatchReportPanel,
  ResultPreviewPanel,
  buildBlockDiffs,
} from "./run-results";
export {
  CREATE_NEW_MASTER,
  SynthesizeForm,
  type SynthesizeFormProps,
} from "./synthesize-form";
export { RunsHistory } from "./runs-history";
