# DevPrism Architecture

DevPrism is a local-first desktop application for scientific LaTeX authoring. The app is packaged with Tauri 2 and keeps documents, project history, skills, settings, and generated artifacts on the user's machine.

## Runtime Layout

```
devprism/
├── apps/desktop/                 # Desktop app workspace
│   ├── src/                      # React, TypeScript, Zustand, CodeMirror UI
│   │   ├── components/           # Workspace, career, chat, settings surfaces
│   │   ├── stores/               # Zustand state (documents, settings, career, updates, …)
│   │   └── lib/                  # career/, resume-synthesis/, mcp/, mupdf/, editor/
│   └── src-tauri/                # Rust/Tauri host runtime
│       ├── src/lib.rs            # Tauri app bootstrap and command registration
│       ├── src/main.rs           # GUI entrypoint plus hidden CLI modes (--mcp, --mcp-http)
│       ├── src/latex.rs          # LaTeX compilation, SyncTeX, Tectonic bundle preflight
│       ├── src/history.rs        # Per-project Git snapshot history and compaction
│       ├── src/proc.rs           # Bounded subprocess execution (timeouts, cancellation, output caps)
│       ├── src/agent_process.rs  # Agent CLI process groups and stop escalation
│       ├── src/claude.rs         # Claude CLI integration, sessions, status probes
│       ├── src/cursor_agent/     # Cursor CLI over ACP (stream adapter + fallback)
│       ├── src/native_agent/     # In-process local/cloud agent loop (+ manvi sidecar client)
│       ├── src/anthropic_proxy/  # Optional Anthropic-compatible proxy (providers, streaming)
│       ├── src/mcp/              # MCP 2.0 server (stdio + HTTP) and career/resume tools
│       ├── src/plugins/          # Capability-pack registry serving MCP + native agent
│       ├── src/career_db/        # Career SQLite store (career.db), watcher, ingest
│       ├── src/career_match/     # Deterministic JD-matching core (port of the TS pipeline)
│       ├── src/career_typst/     # In-process Typst resume engine
│       ├── src/semantic_layer/   # Context compaction primitives
│       ├── src/skills.rs         # Scientific skill installation (~/.claude/skills)
│       ├── src/slash_commands.rs # Project/global slash command discovery
│       ├── src/uv.rs             # uv install and virtualenv orchestration
│       └── src/zotero.rs         # Zotero OAuth and citation access
├── scripts/                      # Desktop build/dev helpers and repo checks
└── docs/                         # Architecture and feature docs
```

## Frontend

The frontend is a Vite React app. It owns the editing workspace, project picker, template gallery, PDF preview, settings, agent chat drawer, career workspace (Database · Knowledge · Synthesize), update notifications, and proposed-change review surfaces. Persistent client state uses Zustand stores under `apps/desktop/src/stores`.

The UI talks to the Rust host through Tauri commands. Browser storage is only used for app UI state (and non-sensitive flow markers such as deferred setup); project data and machine-level integrations are owned by Rust commands.

Notable frontend subsystems:

- `lib/editor/debounced-content-push.ts` coalesces CodeMirror keystrokes into trailing document-store commits so typing on large manuscripts stays O(1) per keystroke (`pnpm --filter @devprism/desktop bench:typing` measures this path).
- `lib/mupdf/page-bitmap-cache.ts` is a byte-budgeted LRU of rendered PDF pages, so zoom/scroll restores do not re-rasterize.
- `lib/career/db-events.ts` subscribes to the Rust `career-db-changed` event so Career surfaces refresh live when an external MCP process commits to `career.db`.

## Rust Host

The Tauri host owns native capabilities and filesystem access:

- LaTeX compilation through TeX Live or embedded Tectonic, including a subprocess mode for isolated runs and a `check_tectonic_bundle` preflight that tells onboarding whether first compiles will work offline.
- Per-project Git history stored in `<project>/.claudeprism/history.git`.
- Skills installed globally under `~/.claude/skills` or per project under `<project>/.claude/skills`; bundled DevPrism skill packages ship as app resources.
- Agent settings under the OS config directory (`DevPrism`), Claude CLI sessions under `~/.claude`.
- The career database at `<app-data>/DevPrism/career.db`, plus a `known_projects` table that registers which folders external agents may touch.
- uv installation and project virtualenv orchestration.
- Zotero OAuth and bibliography access.

Subprocess work is funneled through `proc.rs`, which bounds every child process with timeouts, supports cooperative cancellation, and caps retained output at 64 MiB per stream. Agent CLIs run in their own POSIX process group so Stop reaches grandchildren (dev servers, build tools), escalating SIGINT → SIGKILL after a grace period.

### History retention

Every save snapshots into the project's history repo. After a snapshot crosses 800 commits, history is compacted automatically: labeled checkpoints are kept forever, unlabeled ones are trimmed to the newest 250, and the returned snapshot id is remapped so callers never hold a dangling reference. Restores auto-save uncommitted changes first, and `history_compact` exposes a manual pass.

## Agents, MCP and Plugins

Agent backends are pluggable: Native Ollama / OpenAI-compatible (in-process loop in `native_agent/`, optionally advised by the manvi policy/context-planner sidecar), Claude Code CLI, Cursor CLI (ACP), and cloud providers through the Anthropic-compatible proxy. See [NATIVE_AGENT.md](./NATIVE_AGENT.md) and [CURSOR_CLI.md](./CURSOR_CLI.md).

The same engine also serves external agents:

- `main.rs --mcp` / `--mcp-http` run a stateless MCP 2.0 server over stdio or HTTP ([MCP_RESUME_HARNESS.md](./MCP_RESUME_HARNESS.md)).
- Tools, resources and prompts are registered once in the plugin registry (`plugins/`) and served to both the MCP server and the built-in agent — three packs today (`career-knowledgebase`, `resume-synthesis`, `resume-documents`). See [PLUGINS.md](./PLUGINS.md).

A background watcher polls `career.db`'s `data_version` every 3 s and emits `career-db-changed` when a commit arrives from outside the app process, keeping Career UI surfaces honest while an external agent works.

## Build And Release

Local compile:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm --filter @devprism/desktop test
pnpm docs:verify        # documentation contract (stated facts vs code)
pnpm --filter @devprism/desktop build
```

Native desktop build:

```bash
pnpm build:desktop
```

GitHub Actions builds Windows, macOS Apple Silicon, macOS Intel, and Linux packages from `.github/workflows/build-desktop.yml`. Tags matching `v*` publish draft release assets and `latest.json` for the Tauri updater at `bharathvbcr/DevPrism`.

Local `pnpm build:desktop` produces unsigned bundles. Release builds pass `apps/desktop/src-tauri/tauri.release.conf.json` so updater artifacts are only created in the signed GitHub release path.
