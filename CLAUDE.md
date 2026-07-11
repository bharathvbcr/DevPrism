# Claude Instructions

Use GitNexus as the primary repo map for this workspace.

Before broad exploration:

1. Run `pnpm gitnexus:status`.
2. If needed, run `pnpm gitnexus:analyze`.
3. Use the resulting map to find the canonical file before editing.

This workspace is not a git root, so GitNexus must be run with `--skip-git`.

Prefer:

- `apps/desktop/src` for React and state work.
- `apps/desktop/src-tauri/src` for Rust and Tauri command work.
- `docs/` and root markdown for repo-wide policy and architecture context.

Avoid treating generated outputs, vendor trees, and asset binaries as primary reference material.

## Repo Map

- Canonical map reference: `docs/GITNEXUS_MAP.md`.
- Use it before broad refactors and before crossing app/host boundaries.

## Graphify Trigger

- For any knowledge-graph mapping input, invoke `/graphify` first.

## New Scope Onboarding

- Before editing any new subdirectory, apply the checklist in [docs/AGENTS_SYNC.md](docs/AGENTS_SYNC.md).

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **DevPrism** (7836 symbols, 19143 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
| Work in the Workspace area (368 symbols) | `.claude/skills/generated/workspace/SKILL.md` |
| Work in the Stores area (240 symbols) | `.claude/skills/generated/stores/SKILL.md` |
| Work in the Editor area (239 symbols) | `.claude/skills/generated/editor/SKILL.md` |
| Work in the Components area (221 symbols) | `.claude/skills/generated/components/SKILL.md` |
| Work in the Claude-chat area (208 symbols) | `.claude/skills/generated/claude-chat/SKILL.md` |
| Work in the Native_agent area (154 symbols) | `.claude/skills/generated/native-agent/SKILL.md` |
| Work in the Preview area (132 symbols) | `.claude/skills/generated/preview/SKILL.md` |
| Work in the Browser-project area (118 symbols) | `.claude/skills/generated/browser-project/SKILL.md` |
| Work in the Anthropic_proxy area (112 symbols) | `.claude/skills/generated/anthropic-proxy/SKILL.md` |
| Work in the Cursor_agent area (104 symbols) | `.claude/skills/generated/cursor-agent/SKILL.md` |
| Work in the Ui area (67 symbols) | `.claude/skills/generated/ui/SKILL.md` |
| Work in the Hooks area (40 symbols) | `.claude/skills/generated/hooks/SKILL.md` |
| Work in the Cluster_56 area (37 symbols) | `.claude/skills/generated/cluster-56/SKILL.md` |
| Work in the Semantic-layer area (35 symbols) | `.claude/skills/generated/semantic-layer/SKILL.md` |
| Work in the Template-gallery area (33 symbols) | `.claude/skills/generated/template-gallery/SKILL.md` |
| Work in the Semantic_layer area (32 symbols) | `.claude/skills/generated/semantic-layer-2/SKILL.md` |
| Work in the Semantic-layer-reference area (28 symbols) | `.claude/skills/generated/semantic-layer-reference/SKILL.md` |
| Work in the Mupdf area (27 symbols) | `.claude/skills/generated/mupdf/SKILL.md` |
| Work in the Cluster_3 area (24 symbols) | `.claude/skills/generated/cluster-3/SKILL.md` |
| Work in the Cluster_26 area (24 symbols) | `.claude/skills/generated/cluster-26/SKILL.md` |

<!-- gitnexus:end -->
