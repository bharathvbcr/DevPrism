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

This project is indexed by GitNexus as **DevPrism** (8935 symbols, 21870 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/DevPrism/context` | Codebase overview, check index freshness |
| `gitnexus://repo/DevPrism/clusters` | All functional areas |
| `gitnexus://repo/DevPrism/processes` | All execution flows |
| `gitnexus://repo/DevPrism/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
| Work in the Career area (300 symbols) | `.claude/skills/generated/career/SKILL.md` |
| Work in the Stores area (257 symbols) | `.claude/skills/generated/stores/SKILL.md` |
| Work in the Editor area (247 symbols) | `.claude/skills/generated/editor/SKILL.md` |
| Work in the Workspace area (228 symbols) | `.claude/skills/generated/workspace/SKILL.md` |
| Work in the Claude-chat area (218 symbols) | `.claude/skills/generated/claude-chat/SKILL.md` |
| Work in the Components area (213 symbols) | `.claude/skills/generated/components/SKILL.md` |
| Work in the Native_agent area (209 symbols) | `.claude/skills/generated/native-agent/SKILL.md` |
| Work in the Browser-project area (122 symbols) | `.claude/skills/generated/browser-project/SKILL.md` |
| Work in the Preview area (121 symbols) | `.claude/skills/generated/preview/SKILL.md` |
| Work in the Anthropic_proxy area (112 symbols) | `.claude/skills/generated/anthropic-proxy/SKILL.md` |
| Work in the Resume-synthesis area (111 symbols) | `.claude/skills/generated/resume-synthesis/SKILL.md` |
| Work in the Cursor_agent area (102 symbols) | `.claude/skills/generated/cursor-agent/SKILL.md` |
| Work in the Career_db area (77 symbols) | `.claude/skills/generated/career-db/SKILL.md` |
| Work in the Ui area (60 symbols) | `.claude/skills/generated/ui/SKILL.md` |
| Work in the Mupdf area (48 symbols) | `.claude/skills/generated/mupdf/SKILL.md` |
| Work in the Hooks area (40 symbols) | `.claude/skills/generated/hooks/SKILL.md` |
| Work in the Cluster_65 area (37 symbols) | `.claude/skills/generated/cluster-65/SKILL.md` |
| Work in the Ingest area (35 symbols) | `.claude/skills/generated/ingest/SKILL.md` |
| Work in the Semantic-layer area (33 symbols) | `.claude/skills/generated/semantic-layer/SKILL.md` |
| Work in the Template-gallery area (31 symbols) | `.claude/skills/generated/template-gallery/SKILL.md` |

<!-- gitnexus:end -->
