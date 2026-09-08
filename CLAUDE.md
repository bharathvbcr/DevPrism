<!-- Managed by devmap: keep this file in sync with the repo map. -->

# Agent Workspace Guide

Use `.devcouncil/repo_map.json` as the primary file index for this workspace.
Repo map: `.devcouncil/repo_map.json`
Code graph: `.devcouncil/graph/code_graph.json` (symbol-level; query with `devmap`).

Workflow for agents:
1. Open `.devcouncil/repo_map.json` before guessing at file locations.
2. Use the `files` list to resolve module ownership and nearby siblings.
3. Use `subsystems` for subsystem-level navigation.
4. In `subsystems`, use `entry_points` + `critical_files` for entry points and starting context.
5. Use `role_files` in `subsystems` for subsystem role buckets (tests, entry, api, models, services, config, docs, other). Each bucket is a capped **sample** for orientation, not an inventory — `role_file_counts` carries the real per-role total, and `files` is the complete list.
6. Use `neighbors` and `handoff_paths` in `subsystems` to follow cross-subsystem flow. `handoff_paths` names the ordered file pairs a subsystem reaches other subsystems through; both are capped, and `liveness_meta.subsystems` reports what was cut.
7. For dead code, run `devmap dead --json` and read each row's own `confidence` before acting — a high-confidence row is a parsed fact, a low one is unconfirmed, and the command returns both rather than pre-filtering. Every answer also carries `walk_incomplete` when unattributed calls mean the list is a lower bound. Prefer `unwired_candidates` / `dead_symbol_candidates` in the map over `unreachable_files` (static BFS is noisy for routers, dynamic imports and JSX). If `entry_roots` is empty or `liveness_unreachable_unreliable` is set, ignore `unreachable_files` entirely. Check `unwired_candidates` before creating a new module — wire what you create into a real caller.
8. Use `devmap explore <name>` for a symbol's whole neighbourhood in one call; `devmap search`, `devmap impact`, `devmap trace <a> <b>`, `devmap dead` for the individual questions; `devmap affected <target>` for the tests a change reaches. Read the `truncated` and `total` on every envelope before treating a list as complete.
9. The store (`.devcouncil/codeintel/devmap.sqlite`) is canonical — prefer `devmap` commands when `.devcouncil/graph/code_graph.json` is missing or a size-capped stub. `devmap preview` asks what an unsaved edit would break before it is written.
10. Run `devmap build` after large refactors, or `devmap serve` to keep the index warm; `devmap status` reports generation, counts and freshness.

Important surfaces:
1. `apps/desktop/scripts/` — apps/desktop/scripts: 2 files, typescript
2. `apps/desktop/src-tauri/` — apps/desktop/src-tauri: 100 files, mostly rust, markdown, json (1 api, 2 entry, 1 models, 1 services, 1 tests)
3. `apps/desktop/src/__tests__/lib/` — apps/desktop/src/__tests__/lib: 87 files, mostly typescript, tsx (87 tests)
4. `docs/semantic-layer-reference/` — docs/semantic-layer-reference: 6 files, python (1 api)
5. `apps/desktop/src/lib/` — apps/desktop/src/lib: 143 files, typescript (1 api, 6 entry, 6 models, 2 services, 1 tests)
6. `apps/desktop/` — apps/desktop: 551 files, mostly typescript, tsx, rust (2 api, 13 entry, 8 models, 3 services, 123 tests)

If the map and source disagree, trust the source and re-run `devmap build`.
