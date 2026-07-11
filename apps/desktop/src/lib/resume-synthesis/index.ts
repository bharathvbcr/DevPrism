export {
  applyBoldMarkdown,
  escapeAndValidateSlot,
  escapeLatexSpecials,
  escapeResumeText,
  mapSmartPunctuation,
  normalizeResumePlainText,
  validateEscapedSlot,
  type SlotValidationResult,
} from "./latex-escape";

export {
  bisectSlots,
  careerVerifyCompile,
  compileWithRepairLoop,
  mapErrorLineToSlot,
  SynthesisCompileError,
  type AgentCompileResult,
  type CompileEngine,
  type CompileRepairSuccess,
  type CompileVerifyOptions,
  type LatexCompileErrorItem,
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
  isJDProfile,
  normalizeJDProfile,
  validateJDProfile,
} from "./jd-analysis";

export {
  DEFAULT_WEIGHTS,
  combineScore,
  hybridScore,
  personaAffinity,
  recencyDecay,
  renormalizeWeights,
  scoreBlocks,
  seniorityFit,
  skillOverlap,
  weightsForFacets,
  type ScoreWeights,
} from "./scoring";

export {
  assertBudgetInvariants,
  budgetFromTemplate,
  bulletCoversSkill,
  cosineSimilarity,
  coversSkill,
  DEFAULT_MAX_BULLETS_PER_BLOCK,
  estimateBlockLines,
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
  hasForbiddenLatex,
  metricsPreserved,
  rewriteBlock,
  validateRewriteBlockOut,
  type RewriteBlockOptions,
  type RewriteBlockOut,
  type RewriteBulletOut,
  type RewriteStreamComplete,
} from "./rewrite";

export {
  atsScoreFromReport,
  blockRewriteLabel,
  coverageHeatLabel,
  coverageHeatLevel,
  extractRewriteStreamPreview,
  extractStoredRunTex,
  formatRewriteBlockDetail,
  formatStageMs,
  initBlockProgress,
  listStageTimings,
  parseStoredMatchReport,
  type CoverageHeatLevel,
} from "./synthesis-ux";

export {
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
  synthesizeResume,
  throwIfAborted,
} from "./orchestrator";

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
  CriticBulletVerdict,
  CriticResult,
  JdFacets,
  JDProfile,
  MatchReport,
  MustHaveCoverage,
  RewriteBlockProgress,
  RewriteBlockStatus,
  RewrittenBlockDraft,
  RewrittenBullet,
  ScoreComponents,
  ScoredBlock,
  StageTimingsMs,
  SynthesisDeps,
  SynthesisResult,
  SynthesisStage,
  SynthesisStageId,
  SynthesizeResumeOptions,
} from "./types";
