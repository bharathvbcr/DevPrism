# Career DB (Rust)

Local SQLite career database: experience blocks, personas, KB chunks, embeddings, synthesis runs.

Commands include block/persona CRUD, `career_delete_persona` (guards seeded ids), KB ingest, embeddings, and vector search. `career_list_blocks` accepts `missingEmbeddingsOnly` for block embed backfill.

Embeddings use composite PK `(owner_id, model)`. Vector search prefers sqlite-vec `vec_embeddings` (ANN KNN + over-fetch/post-filter) and falls back to brute-force cosine. `career_delete_block` also removes child bullet embedding rows.

## Repo Map

- Canonical map: `../../../../docs/GITNEXUS_MAP.md`
- Frontend client: `apps/desktop/src/lib/career/`
- Host module: this directory (`career_db`)

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
