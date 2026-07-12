# Career DB (Rust)

Local SQLite career database: experience blocks (incl. Fact Pool JSON), personas, KB chunks, embeddings, synthesis runs.

Commands include block/persona CRUD, `career_delete_persona` (guards seeded ids), KB ingest, embeddings, and vector search. `career_list_blocks` accepts `missingEmbeddingsOnly` for block embed backfill.

Embeddings use composite PK `(owner_id, model)`. `owner_kind` includes `block` \| `chunk` \| `bullet` \| `fact`. Vector search prefers sqlite-vec `vec_embeddings` (ANN KNN + over-fetch/post-filter) and falls back to brute-force cosine. `resolve_hit_text` returns text for bullet and fact hits. `career_delete_block` also removes child bullet **and** fact embedding rows. Serde defaults keep old block rows loadable without `facts`/`notes`.

## Repo Map

- Canonical map: `../../../../docs/GITNEXUS_MAP.md`
- Design: `docs/CAREER_PLATFORM_DESIGN.md`, `docs/RESUME_SYNTHESIS.md`
- Frontend client: `apps/desktop/src/lib/career/`
- Host module: this directory (`career_db`)

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
