# Tier 1 Feature Coverage E2E Tests

End-to-end feature coverage tests for Editor UX (Features 1–5), Typst Engine (Features 6–12), and Manvi/Vani integration (Features 13–16).

## Repo Map

- Canonical map: `.devcouncil/repo_map.json`
- Ownership boundaries: `docs/DEV_MAP.md`
- Refresh with `dev map` (or `dev map --if-stale`) before broad edits.

## Must Use Map

- Before broad exploration or edits, open `.devcouncil/repo_map.json` (or MCP `devcouncil_repo_map`).
- Before changing a symbol/file, check callers with `dev graph query` / `devcouncil_graph_query`.
- Before risky edits, check blast radius with `dev graph impact` / `devcouncil_impact`.
