# Career client (TypeScript)

Tauri command wrappers and types for the Master Career Database.

## Repo Map

- Canonical map: `../../../../docs/GITNEXUS_MAP.md`
- Design: `docs/CAREER_PLATFORM_DESIGN.md`, `docs/RESUME_SYNTHESIS.md`
- Rust host: `apps/desktop/src-tauri/src/career_db/`
- Types: `types.ts` (`ExperienceBlock` + `BlockFact` Fact Pool / `notes`; `EmbeddingOwnerKind`: `block` \| `chunk` \| `bullet` \| `fact`); invoke wrappers: `index.ts`
- KB ingestion: `ingest/` (markdown/PDF/OPML chunkers, embed pipeline, Zotero seed; `ProcessingProgress` callbacks)
- Fact ingest: `distill-facts.ts` (`distillFactsFromNotes` → structured `BlockFact[]`); helpers in `block-helpers.ts` (`newBlockFact`, `computeEmbeddingText` folds fact texts)
- Block/bullet/fact embeddings: `block-embed.ts` (persist on save + `backfillBlockEmbeddings` / `backfillBulletEmbeddings` / `backfillFactEmbeddings`)
- Resume extract: `extract-resume.ts` may emit `facts` with `source: "import"`

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
