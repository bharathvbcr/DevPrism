# Career client (TypeScript)

Tauri command wrappers and types for the Master Career Database.

## Repo Map

- Canonical map: `../../../../docs/GITNEXUS_MAP.md`
- Rust host: `apps/desktop/src-tauri/src/career_db/`
- Types: `types.ts`; invoke wrappers: `index.ts`
- KB ingestion: `ingest/` (markdown/PDF/OPML chunkers, embed pipeline, Zotero seed; `ProcessingProgress` callbacks)
- Block/bullet embeddings: `block-embed.ts` (persist on save + `backfillBlockEmbeddings` / `backfillBulletEmbeddings`; `ownerKind: "block" | "bullet"`)

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
