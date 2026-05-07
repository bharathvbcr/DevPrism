# GitNexus Repo Map

## Indexing

- Repo: `devprism-main`
- Commit indexed: `f5245e4`
- Node/tooling entrypoints:
  - `pnpm gitnexus:status`
  - `pnpm gitnexus:analyze`
  - `pnpm gitnexus:refresh`
- GitNexus runs here with `--skip-git`; the package scripts already include that flag, and manual CLI usage should too.

## Top-Level Boundaries

- React + app shell in `apps/desktop/src`.
- Tauri host and Rust integrations in `apps/desktop/src-tauri/src`.
- Shared docs and conventions in `docs/`, root markdown, and `AGENTS.md` / `CLAUDE.md`.

## Frontend Boundary (`apps/desktop/src`)

- App bootstrap:
  - `main.tsx`
  - `App.tsx`
- Workspace and navigation:
  - `components/workspace/workspace-layout.tsx`
- Shared UI primitives and shell utilities:
  - `components/ui/*`
  - `components/assistant-ui/*`
  - `components/debug/*`
  - `components/template-gallery/*`
  - `hooks/*`
  - `lib/*`
  - `styles/*`
- Stores (source of truth for UI state):
  - `stores/project-store`
  - `stores/document-store`
  - `stores/agent-chat-store`
  - `stores/history-store`
  - `stores/settings-store`
  - `stores/template-store`
  - `stores/uv-setup-store`
  - `stores/zotero-store`
  - `stores/dev-engine-setup-store`
  - `stores/proposed-changes-store`
- Feature areas:
  - `components/agent-chat/*`
  - `components/workspace/editor/*`
  - `components/workspace/preview/*`
  - `components/project-picker.tsx`
  - `components/project-wizard.tsx`
  - `components/scientific-skills/*`
- Tests and mocks:
  - `__tests__/*`

## Rust Boundary (`apps/desktop/src-tauri/src`)

- Tauri command surface:
  - `src-tauri/src/lib.rs`
- Agent orchestration:
  - `src-tauri/src/agent/mod.rs`
  - `src-tauri/src/agent/providers/*`
  - `src-tauri/src/agent/tools/*`
  - `src-tauri/src/agent/knowledge/*`
- Native integrations:
  - `src-tauri/src/latex.rs`
  - `src-tauri/src/history.rs`
  - `src-tauri/src/uv.rs`
  - `src-tauri/src/zotero.rs`
  - `src-tauri/src/skills.rs`
  - `src-tauri/src/slash_commands.rs`
  - `src-tauri/src/agent_runtime.rs`
  - `src-tauri/src/main.rs` (CLI fallback entrypoint)

## Recommended Search Pattern for Edits

1. Run `pnpm gitnexus:status` or the equivalent `gitnexus status --skip-git`.
2. Use `gitnexus` map/query/context to find canonical owner(s).
3. Inspect only the owning boundary first, then touch the smallest surface.

## Canonical Source-of-Truth Reminder

- Treat generated directories (`node_modules`, `dist`, `target`, compiled assets, binaries) as non-authoritative.
