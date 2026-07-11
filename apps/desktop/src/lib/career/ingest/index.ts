/** Career KB ingestion — chunkers, embedding pipeline, Zotero seeding. */

export {
  CHARS_PER_TOKEN,
  TARGET_MIN_TOKENS,
  TARGET_MAX_TOKENS,
  TARGET_CHARS,
  TARGET_MIN_CHARS,
  TARGET_MAX_CHARS,
  OVERLAP_RATIO,
  chunkSections,
  chunkPlainText,
  splitToWindows,
  estimateTokens,
  type TextSection,
  type ChunkOptions,
} from "./chunking";

export {
  chunkMarkdown,
  stripFrontmatter,
  simplifyObsidian,
  splitByHeadings,
  type MarkdownChunkOptions,
} from "./markdown";

export {
  chunkMindmap,
  flattenOpml,
  flattenFreemind,
  type MindmapChunkOptions,
} from "./mindmap";

export {
  flattenPageText,
  extractPdfPages,
  chunkPdf,
  chunkPdfPageTexts,
  type PdfChunkOptions,
} from "./pdf";

export { sha1Hex, sha1HexSync } from "./hash";

export {
  EMBED_BATCH_SIZE,
  embedChunks,
  backfillKbEmbeddings,
  isEmbedDeferred,
  type EmbedChunksOptions,
} from "./embed";

export {
  buildPreparedSource,
  upsertAndEmbed,
  ingestMarkdownText,
  ingestMindmapText,
  ingestPdfBuffer,
  ingestFilePath,
  type IngestAndEmbedResult,
  type IngestTextOptions,
  type ProcessingProgress,
  type ProcessingPhase,
} from "./pipeline";

export {
  bibEntryVenue,
  bibEntriesToChunks,
  bibEntryToPublicationBlock,
  bibEntriesToPublicationBlocks,
  parseBibtexToPublicationBlocks,
  seedPublicationsFromBibtex,
  type BibSeedOptions,
  type BibSeedResult,
} from "./zotero";
