# Agent Instructions

This repo is indexed with GitNexus. Use the index before doing broad file searches or large refactors.

## GitNexus Workflow

- Check the index first with `pnpm gitnexus:status`.
- If the repo is not indexed, rebuild it with `pnpm gitnexus:analyze`.
- If the repo structure changes substantially, refresh with `pnpm gitnexus:refresh`.
- This checkout is not a git root, so GitNexus must run with `--skip-git` here.

## What To Use The Map For

- Prefer GitNexus context for locating files, modules, and call paths.
- Use the map to find the canonical owner before editing.
- Treat `.gitnexus/` as generated output, not a source directory.

## Repo Boundaries

- Frontend code lives under `apps/desktop/src`.
- Tauri and Rust host code lives under `apps/desktop/src-tauri/src`.
- Shared docs and repo-level guidance live under `docs/` and the root markdown files.

## Noise To Avoid

- Do not spend time in `node_modules/`, `dist/`, `target/`, or generated binary assets when reasoning about the codebase.
- Do not use the raw asset folders as the source of truth for code ownership.

## Repo Map

- Canonical repo map is at `docs/GITNEXUS_MAP.md`.
- Use it before broad refactors and when crossing between frontend and Rust boundaries.

## Graphify Trigger

- Any input that asks for knowledge-graph mapping should trigger the Graphify skill first: `/graphify`.

## New Scope Onboarding

- Before editing any new subdirectory, apply the checklist in [docs/AGENTS_SYNC.md](docs/AGENTS_SYNC.md).

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **devprism-main** (3972 symbols, 7120 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/devprism-main/context` | Codebase overview, check index freshness |
| `gitnexus://repo/devprism-main/clusters` | All functional areas |
| `gitnexus://repo/devprism-main/processes` | All execution flows |
| `gitnexus://repo/devprism-main/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
| Work in the Ui area (53 symbols) | `.claude/skills/generated/ui/SKILL.md` |
| Work in the Knowledge area (48 symbols) | `.claude/skills/generated/knowledge/SKILL.md` |
| Work in the Cluster_39 area (37 symbols) | `.claude/skills/generated/cluster-39/SKILL.md` |
| Work in the Providers area (28 symbols) | `.claude/skills/generated/providers/SKILL.md` |
| Work in the Agent-chat area (28 symbols) | `.claude/skills/generated/agent-chat/SKILL.md` |
| Work in the Mupdf area (25 symbols) | `.claude/skills/generated/mupdf/SKILL.md` |
| Work in the Agent area (24 symbols) | `.claude/skills/generated/agent/SKILL.md` |
| Work in the Hooks area (23 symbols) | `.claude/skills/generated/hooks/SKILL.md` |
| Work in the Stores area (20 symbols) | `.claude/skills/generated/stores/SKILL.md` |
| Work in the Workspace area (19 symbols) | `.claude/skills/generated/workspace/SKILL.md` |
| Work in the Scripts area (18 symbols) | `.claude/skills/generated/scripts/SKILL.md` |
| Work in the Tools area (17 symbols) | `.claude/skills/generated/tools/SKILL.md` |
| Work in the Components area (16 symbols) | `.claude/skills/generated/components/SKILL.md` |
| Work in the Editor area (15 symbols) | `.claude/skills/generated/editor/SKILL.md` |
| Work in the Cluster_6 area (14 symbols) | `.claude/skills/generated/cluster-6/SKILL.md` |
| Work in the Cluster_10 area (11 symbols) | `.claude/skills/generated/cluster-10/SKILL.md` |
| Work in the Cluster_40 area (11 symbols) | `.claude/skills/generated/cluster-40/SKILL.md` |
| Work in the Preview area (11 symbols) | `.claude/skills/generated/preview/SKILL.md` |
| Work in the Tauri area (11 symbols) | `.claude/skills/generated/tauri/SKILL.md` |
| Work in the Cluster_14 area (10 symbols) | `.claude/skills/generated/cluster-14/SKILL.md` |

<!-- gitnexus:end -->
