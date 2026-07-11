# Career KB ingestion

TypeScript chunkers and embedding pipeline for the Master Career Database knowledge base.

## Repo Map

- Canonical map: `../../../../../docs/GITNEXUS_MAP.md`
- Parent client: `apps/desktop/src/lib/career/`
- Rust host: `apps/desktop/src-tauri/src/career_db/ingest.rs`
- Progress: `ProcessingProgress` threaded via `pipeline.ts` / `embed.ts` `onProgress` / `onProcessingProgress`
- BibTeX: `zotero.ts` — KB chunks (`seedPublicationsFromBibtex`) and publication blocks (`bibEntriesToPublicationBlocks`)

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
