<!-- Managed by dev map: keep this file in sync with .devcouncil/repo_map.json. -->

# Agent Workspace Guide

Use `.devcouncil/repo_map.json` as the primary file index for this workspace.
Repo map: `.devcouncil/repo_map.json`
Code graph: `.devcouncil/graph/code_graph.json` (symbol-level; query with `dev map`).

Workflow for agents:
1. Open `.devcouncil/repo_map.json` before guessing at file locations.
2. Use the `files` list to resolve module ownership and nearby siblings.
3. Use `subsystems` for subsystem-level navigation.
4. In `subsystems`, use `entry_points` + `critical_files` for entry points and starting context.
5. Use `role_files` in `subsystems` for subsystem role buckets (entry, runtime, policy, adapters, etc.).
6. Use `neighbors` and `handoff_paths` in `subsystems` to follow cross-subsystem flow.
7. Prefer `dev map dead --confidence extracted` + file greps for dead code. Treat `inferred` as unconfirmed. Prefer `unwired_candidates` / `dead_symbol_candidates` over `unreachable_files` (static BFS is often noisy for routers / dynamic imports / JSX). If `entry_roots` are empty / `liveness_unreachable_unreliable`, ignore `unreachable_files` and mass inferred dead. Check `unwired_candidates` / `dead_symbol_candidates` before creating new modules — wire what you create into a real caller.
8. Use `dev map query <name>` / `dev map trace <a> <b>` / `dev map dead` for symbol callers, paths, and dead-code tiers; `dev map graph-html` (or `dev map html --symbols`) for the symbol visualizer. SQLite (`.devcouncil/codeintel/index.sqlite`) is canonical — prefer `dev map` commands when `code_graph.json` is missing or a size-capped stub.
9. Run `dev map` (or `dev map --watch` / `dev map watch`) after large refactors.

DevCouncil loop:
- Prefer DevCouncil MCP tools (`devcouncil_status`, `devcouncil_checkout_task`, `devcouncil_verify_task`, …) for task state; do not guess.
- Interactive Shell does not need a lease under assist (`hook_gate.mode=off`); checkout before writes only when write-gates / contain mode are active.
- Engineering skills live under `.claude/skills/` and `.cursor/skills/` (`dev skills scaffold` / `dev integrate cursor --apply`).

Important surfaces:
1. `apps/desktop/` — desktop: postcss.config, vite.config [apps/desktop#6]
2. `apps/desktop/scripts/` — scripts: generate-previews [apps/desktop#2]
3. `apps/desktop/src/` — src: App, career-view, debug-page [apps/desktop#6]
4. `apps/desktop/src-tauri/` — src-tauri: lib, main, mod [apps/desktop#4]
5. `docs/` — docs: threshold, __init__, cache [docs/semantic-layer-reference]
6. `scripts/` — scripts: build-desktop, dev-desktop [apps/desktop#2]

If the map and source disagree, trust the source and regenerate the map.
