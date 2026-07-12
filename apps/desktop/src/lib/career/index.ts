import { invoke } from "@tauri-apps/api/core";
import type {
  ExperienceBlock,
  KbChunkRow,
  KbSourceRow,
  Persona,
  ScoredHit,
  SearchFilter,
  SynthesisRun,
} from "./types";

export type {
  BlockFact,
  BlockKind,
  Bullet,
  BulletMetric,
  DateRange,
  EmbedPipelineResult,
  EmbeddingItem,
  EmbeddingOwnerKind,
  ExperienceBlock,
  IngestReport,
  KbChunkMeta,
  KbChunkRow,
  KbSourceRow,
  KbSourceType,
  Persona,
  PersonaId,
  PreparedChunk,
  PreparedSource,
  ProcessingPhase,
  ProcessingProgress,
  ScoredHit,
  SearchFilter,
  SectionKind,
  SeniorityLevel,
  SkillTag,
  SynthesisRun,
} from "./types";

export * from "./ingest";
export * from "./block-helpers";
export * from "./block-embed";
export { extractBlocksFromResume } from "./extract-resume";
export {
  distillFactsFromNotes,
  parseDistilledFacts,
} from "./distill-facts";

export function listBlocks(
  missingEmbeddingsOnly = false,
): Promise<ExperienceBlock[]> {
  return invoke<ExperienceBlock[]>("career_list_blocks", {
    missingEmbeddingsOnly,
  });
}

export function upsertBlock(block: ExperienceBlock): Promise<void> {
  return invoke<void>("career_upsert_block", { block });
}

export function deleteBlock(id: string): Promise<void> {
  return invoke<void>("career_delete_block", { id });
}

export function listPersonas(): Promise<Persona[]> {
  return invoke<Persona[]>("career_list_personas");
}

export function upsertPersona(persona: Persona): Promise<void> {
  return invoke<void>("career_upsert_persona", { persona });
}

export function deletePersona(id: string): Promise<void> {
  return invoke<void>("career_delete_persona", { id });
}

export function listKbSources(): Promise<KbSourceRow[]> {
  return invoke<KbSourceRow[]>("career_list_kb_sources");
}

export function listKbChunks(
  sourceId?: string,
  missingEmbeddingsOnly = false,
): Promise<KbChunkRow[]> {
  return invoke<KbChunkRow[]>("career_list_kb_chunks", {
    sourceId: sourceId ?? null,
    missingEmbeddingsOnly,
  });
}

/** Count of KB chunks with no embedding row (for readiness / badges). */
export function countKbChunksMissingEmbeddings(
  sourceId?: string,
): Promise<number> {
  return invoke<number>("career_count_kb_chunks_missing_embeddings", {
    sourceId: sourceId ?? null,
  });
}

export function deleteKbSource(sourceId: string): Promise<void> {
  return invoke<void>("career_delete_kb_source", { sourceId });
}

export function vectorSearch(
  queryVec: number[],
  k: number,
  filter?: SearchFilter,
): Promise<ScoredHit[]> {
  return invoke<ScoredHit[]>("career_vector_search", {
    queryVec,
    k,
    filter: filter ?? null,
  });
}

export function saveRun(run: SynthesisRun): Promise<void> {
  return invoke<void>("career_save_run", { run });
}

export function listRuns(): Promise<SynthesisRun[]> {
  return invoke<SynthesisRun[]>("career_list_runs");
}
