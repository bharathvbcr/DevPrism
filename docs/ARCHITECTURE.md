# DevPrism Architecture

DevPrism is a local-first desktop application for scientific LaTeX authoring. The app is packaged with Tauri 2 and keeps documents, project history, skills, settings, and generated artifacts on the user's machine.

## Runtime Layout

```
devprism/
├── apps/desktop/                 # Desktop app workspace
│   ├── src/                      # React, TypeScript, Zustand, CodeMirror UI
│   ├── public/examples/          # Bundled LaTeX starter projects
│   └── src-tauri/                # Rust/Tauri host runtime
│       ├── src/lib.rs            # Tauri app bootstrap and command registration
│       ├── src/main.rs           # GUI entrypoint plus hidden CLI modes
│       ├── src/latex.rs          # Tectonic compilation and SyncTeX support
│       ├── src/history.rs        # Per-project Git history snapshots
│       ├── src/claude.rs         # Agent CLI process integration and settings
│       ├── src/skills.rs         # Scientific skill installation
│       ├── src/slash_commands.rs # Project/global slash command discovery
│       ├── src/uv.rs             # uv install and virtualenv orchestration
│       └── src/zotero.rs         # Zotero OAuth and citation access
├── .github/workflows/            # Lint, desktop build, and release pipelines
├── scripts/                      # Manual release helpers
└── docs/                         # Architecture and release docs
```

## Frontend

The frontend is a Vite React app. It owns the editing workspace, project picker, template gallery, PDF preview, settings, agent chat drawer, and proposed-change review surfaces. Persistent client state uses Zustand stores under `apps/desktop/src/stores`.

The UI talks to the Rust host through Tauri commands. Browser storage is only used for app UI state; project data and machine-level integrations are owned by Rust commands.

## Rust Host

The Tauri host owns native capabilities and filesystem access:

- LaTeX compilation through Tectonic, including a subprocess mode for isolated compiler runs.
- Local Git history in `.devprism/history.git`.
- Project and global skills under `.devprism/skills`.
- Agent settings and linked-project knowledge under `~/.devprism`.
- uv installation and project virtualenv orchestration.
- Zotero OAuth and bibliography access.

On startup, DevPrism migrates legacy local config directories into `~/.devprism` when needed.

## Build And Release

Local compile:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm --filter @devprism/desktop test
pnpm --filter @devprism/desktop build
```

Native desktop build:

```bash
pnpm build
```

GitHub Actions builds Windows, macOS Apple Silicon, macOS Intel, and Linux packages from `.github/workflows/build-desktop.yml`. Tags matching `v*` publish draft release assets and `latest.json` for the Tauri updater at `bharathvbcr/DevPrism`.

Local `pnpm build` produces unsigned bundles. Release builds pass `apps/desktop/src-tauri/tauri.release.conf.json` so updater artifacts are only created in the signed GitHub release path.
