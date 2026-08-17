export { draftsToContent } from "./orchestrator";

export {
  clampSlotText,
  escapeTypstStringBody,
  MAX_RICH_PARTS,
  MAX_SLOT_CHARS,
  normalizeTypstPlainText,
  parseRichParts,
  toTypstRich,
  toTypstString,
  toTypstUrl,
  typstStringOrCanonical,
  validateTypstString,
  type RichPart,
} from "./typst-escape";

export {
  summarizeTypstResult,
  typstCompile,
  typstFontFamilies,
  typstPdfBytes,
  type TypstCompileResult,
  type TypstDiagnostic,
} from "./typst-compile";

export {
  compileResumeDocument,
  mapDiagnosticToSlot,
  type ResumeCompileOptions,
  type ResumeCompileOutcome,
} from "./compile-verify";

export {
  llmJson,
  tryParseJson,
  parseJsonObjectLoose,
  LlmJsonError,
  type LlmJsonOptions,
} from "./llm-json";

export {
  analyzeJobDescription,
  facetsOf,
  isExtractionEmpty,
  isJDProfile,
  JD_NONTRIVIAL_MIN_CHARS,
  normalizeJDProfile,
  validateJDProfile,
  type AnalyzeJobDescriptionResult,
} from "./jd-analysis";

export {
  DEFAULT_WEIGHTS,
  canonicalSkillKey,
  combineScore,
  hybridScore,
  normSkill,
  personaAffinity,
  recencyDecay,
  renormalizeWeights,
  scoreBlocks,
  seniorityFit,
  skillOverlap,
  skillTokens,
  skillsMatch,
  textCoversSkill,
  weightsForFacets,
  type ScoreWeights,
} from "./scoring";

export {
  assertBudgetInvariants,
  budgetFromTemplate,
  bulletCoversSkill,
  BUDGET_FIXED_OVERHEAD_LINES,
  CHARS_PER_LINE,
  cosineSimilarity,
  coversSkill,
  DEFAULT_MAX_BULLETS_PER_BLOCK,
  estimateBlockLines,
  estimateBulletLines,
  knapsackSelect,
  mmrSelect,
  sectionForBlock,
  trimSelectedBullets,
  type MmrCandidate,
  type SelectionBudget,
  type SelectionResult,
  type TrimBulletsOptions,
} from "./selection";

export {
  buildRewritePrompt,
  enforceBulletInvariants,
  enforceFactOnlyInvariants,
  hasForbiddenLatex,
  hasProvenance,
  metricsFromProvenance,
  metricsPreserved,
  metricsValuesPreserved,
  normalizeDistillBullet,
  rewriteBlock,
  validateDistillBlockOut,
  validateRewriteBlockOut,
  type EnforceBulletOptions,
  type RewriteBlockOptions,
  type RewriteBlockOut,
  type RewriteBulletOut,
  type RewriteStreamComplete,
} from "./rewrite";

export {
  analyzeMustHaveGaps,
  collectBlockSkillHits,
  collectKbSkillHits,
  gapItemsByStatus,
  gapMissingOrWeak,
  type AnalyzeMustHaveGapsOptions,
} from "./gap-analysis";

export {
  atsScoreFromReport,
  blockRewriteLabel,
  coalesceRunEventsForPersistence,
  coverageHeatLabel,
  coverageHeatLevel,
  extractRewriteStreamPreview,
  extractStoredCompileMeta,
  extractStoredRunEvents,
  extractStoredRunTex,
  formatRewriteBlockDetail,
  formatStageMs,
  initBlockProgress,
  listStageTimings,
  parseStoredMatchReport,
  type CoverageHeatLevel,
} from "./synthesis-ux";

export {
  computeAtsCoveragePct,
  repairFlagged,
  repairProgrammatic,
  runCritic,
  runProgrammaticChecks,
  validateCriticOut,
  type CriticLlmOut,
} from "./critic";

export {
  buildMustHaveCoverage,
  isAbortError,
  retrieveBlockFacts,
  summarizeRewriteHonesty,
  synthesizeResume,
  throwIfAborted,
} from "./orchestrator";

export {
  checkSynthesisReadiness,
  clearEmbedProbeCache,
  pendingEmbedCount,
  type DataReadiness,
  type EmbeddingIssue,
  type EmbeddingReadiness,
  type ReadinessLevel,
  type SynthesisReadiness,
  type TextGenerationIssue,
  type TextGenerationReadiness,
} from "./preflight";

export {
  listResumeMasterOptions,
  materializeSynthesis,
  slugFromJd,
  slugFromVersionName,
  templateDisplayName,
  versionNameFromJd,
  type MaterializeOptions,
  type MaterializeResult,
  type ResumeMasterOption,
} from "./materialize";

export type {
  BlockBulletDiff,
  BlockEvidenceSummary,
  BlockFactEvidenceSummary,
  BulletFallbackReason,
  BulletFallbackSummary,
  BulletProvenance,
  CriticBulletVerdict,
  CriticResult,
  GapAnalysis,
  GapAnalysisItem,
  GapCoverageStatus,
  GapHit,
  GapHitKind,
  JdFacets,
  JDProfile,
  MatchReport,
  MustHaveCoverage,
  RewriteBlockProgress,
  RewriteBlockStatus,
  RewrittenBlockDraft,
  RewrittenBullet,
  RunEvent,
  ScoreComponents,
  ScoredBlock,
  StageTimingsMs,
  SynthesisDeps,
  SynthesisResult,
  SynthesisStage,
  SynthesisStageId,
  SynthesizeResumeOptions,
} from "./types";
