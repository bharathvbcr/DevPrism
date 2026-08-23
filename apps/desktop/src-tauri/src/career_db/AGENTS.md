# Career DB (Rust)

Local SQLite career database: experience blocks (incl. Fact Pool JSON), personas, KB chunks, embeddings, synthesis runs, and `known_projects` — the registry of opened folders that gates external agents' document tools.

A background watcher (`watch_external_changes`) polls `PRAGMA data_version` every 3 s and emits the `career-db-changed` Tauri event when a commit lands from outside this process (in-app MCP server or `--mcp-stdio`); it is best-effort and never fatal.

Commands include block/persona CRUD, `career_delete_persona` (guards seeded ids), KB ingest, embeddings, and vector search. `career_list_blocks` accepts `missingEmbeddingsOnly` for block embed backfill.

Embeddings use composite PK `(owner_id, model)`. `owner_kind` includes `block` \| `chunk` \| `bullet` \| `fact`. Vector search prefers sqlite-vec `vec_embeddings` (ANN KNN + over-fetch/post-filter) and falls back to brute-force cosine. `resolve_hit_text` returns text for bullet and fact hits. `career_delete_block` also removes child bullet **and** fact embedding rows. Serde defaults keep old block rows loadable without `facts`/`notes`.

## Repo Map

- Canonical map: `.devcouncil/repo_map.json`
- Ownership boundaries: `docs/DEV_MAP.md`
- Refresh with `dev map` (or `dev map --if-stale`) before broad edits.

## Must Use Map

- Before broad exploration or edits, open `.devcouncil/repo_map.json` (or MCP `devcouncil_repo_map`).
- Before changing a symbol/file, check callers with `dev graph query` / `devcouncil_graph_query`.
- Before risky edits, check blast radius with `dev graph impact` / `devcouncil_impact`.
