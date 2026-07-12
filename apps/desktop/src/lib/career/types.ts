/** Canonical career DB types (mirrored by Rust serde structs in career_db). */

export type PersonaId = string;

export type BlockKind =
  | "experience"
  | "project"
  | "publication"
  | "education"
  | "leadership";

export type SeniorityLevel = "ic" | "senior" | "lead" | "manager" | "director";

export type SectionKind =
  | "experience"
  | "projects"
  | "skills"
  | "education"
  | "publications"
  | "leadership";

export type KbSourceType =
  | "wiki"
  | "publication"
  | "mindmap"
  | "markdown"
  | "pdf";

export type EmbeddingOwnerKind = "block" | "chunk" | "bullet" | "fact";

export interface DateRange {
  start: string;
  end: string | null;
}

export interface SkillTag {
  name: string;
  level: 1 | 2 | 3 | 4 | 5;
  years?: number;
}

export interface BulletMetric {
  value: string;
  kind: string;
}

export interface Bullet {
  id: string;
  /** Ground-truth phrasing; source of factual claims. */
  canonical: string;
  /** Pre-authored persona spins. */
  variants: Partial<Record<PersonaId, string>>;
  /** Metric strings that must survive rewriting. */
  metrics: BulletMetric[];
  /** KB chunk ids grounding the claim. */
  evidenceRefs: string[];
  /** If true, AI may select but never re-phrase. */
  locked: boolean;
}

/** Raw detail point in a block's Fact Pool (ground truth for distillation). */
export interface BlockFact {
  id: string;
  /** One raw detail point (ground truth). */
  text: string;
  /** Optional skill tags for must-have coverage targeting. */
  skills: string[];
  /** Values that must survive verbatim when distilled into bullets. */
  metrics: BulletMetric[];
  source: "manual" | "distilled" | "import";
  createdAt: string;
}

export interface ExperienceBlock {
  id: string;
  kind: BlockKind;
  title: string;
  org: string;
  dateRange: DateRange;
  personas: PersonaId[];
  domains: string[];
  skills: SkillTag[];
  seniorityLevel: SeniorityLevel;
  bullets: Bullet[];
  /** Raw knowledge pool ("10+ points") for JD-tailored distillation. */
  facts: BlockFact[];
  /** Free-form scratchpad; distill input for AI fact extraction. */
  notes?: string;
  /** Computed: title+org+domains+canonical bullets+fact texts. */
  embeddingText?: string;
  updatedAt: string;
}

export interface Persona {
  id: PersonaId;
  label: string;
  skillWeights: Record<string, number>;
  defaultTemplateId: string;
  sectionOrder: SectionKind[];
  toneDirective: string;
}

export interface EmbeddingItem {
  ownerId: string;
  ownerKind: EmbeddingOwnerKind | string;
  model: string;
  vec: number[];
}

export interface SearchFilter {
  ownerKind?: EmbeddingOwnerKind | string;
  personas?: PersonaId[];
  domains?: string[];
  kinds?: BlockKind[] | string[];
  /** When set, search only this embed model. Rust picks one model if omitted. */
  model?: string;
}

export interface ScoredHit {
  ownerId: string;
  ownerKind: string;
  score: number;
  text: string;
  meta: unknown;
}

export interface IngestReport {
  sourceId: string;
  chunkCount: number;
  contentHash: string;
  skipped: boolean;
  chunkIds: string[];
  /** Chunk ids that still need (re-)embedding after this upsert. */
  needsEmbedding?: string[];
  title: string;
}

/** Chunk meta stored in `kb_chunks.meta_json`. */
export interface KbChunkMeta {
  sourceTitle: string;
  headingPath: string[];
  contentHash: string;
  index?: number;
  date?: string;
  page?: number;
  [key: string]: unknown;
}

export interface PreparedChunk {
  text: string;
  meta: KbChunkMeta;
}

export interface PreparedSource {
  uri: string;
  sourceType: string;
  title: string;
  contentHash: string;
  chunks: PreparedChunk[];
}

export interface KbSourceRow {
  id: string;
  sourceType: string;
  uri: string | null;
  title: string | null;
  contentHash: string | null;
  ingestedAt: number | null;
  chunkCount: number;
}

export interface KbChunkRow {
  id: string;
  sourceId: string;
  text: string;
  meta: KbChunkMeta | unknown;
  hasEmbedding: boolean;
}

export interface EmbedPipelineResult {
  embedded: number;
  skipped: number;
  /** True when no embedding provider was available. */
  deferred: boolean;
  error?: string;
}

/** Phases for unified ingest / embed progress UI. */
export type ProcessingPhase =
  | "parse"
  | "chunk"
  | "hash"
  | "upsert"
  | "embed"
  | "done"
  | "error";

/**
 * Shared progress payload for Knowledge ingest, Embed-all, and import wizard.
 * `current`/`total` are 1-based item or batch indices when total > 0.
 */
export interface ProcessingProgress {
  phase: ProcessingPhase;
  current: number;
  total: number;
  itemLabel?: string;
  /** Bytes read (e.g. PDF buffer size). */
  bytes?: number;
  /** Chunks produced or embedded so far. */
  chunks?: number;
  detail?: string;
}

export interface SynthesisRun {
  id: string;
  jdHash: string;
  personaId: string;
  templateId: string;
  reportJson: unknown;
  /** Epoch milliseconds. */
  createdAt: number;
}
