<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="ClaudePrism" />
</p>

<h1 align="center">ClaudePrism</h1>

<p align="center">
  Open-source AI-powered LaTeX writing workspace with live preview.
</p>

<p align="center">
  <a href="https://github.com/delibae/claude-prism/releases">Releases</a> ·
  <a href="#installation">Install</a> ·
  <a href="#development">Development</a>
</p>

---

## Features

- **Claude AI Assistant** — Chat with Claude directly in the editor. Supports Sonnet, Opus, Haiku models with adjustable reasoning effort. Slash commands, tool use, and session persistence.
- **LaTeX Editor** — CodeMirror 6 with LaTeX/BibTeX syntax highlighting, real-time linting, find & replace, and multi-file project support.
- **Live PDF Preview** — Native MuPDF rendering with SyncTeX (click PDF → jump to source), zoom, text selection, and annotation capture.
- **Tectonic Compilation** — Self-contained LaTeX compiler built in. No TeX Live installation required.
- **Zotero Integration** — OAuth-based bibliography management and citation insertion.
- **Proposed Changes** — AI-suggested edits with visual diff review (accept/reject per chunk).
- **Template Gallery** — Pre-built LaTeX templates to start projects quickly.
- **Project Management** — File browser, folder creation, file import, and auto-save.
- **External Editor Support** — Open projects in Cursor, VS Code, Zed, or Sublime Text.
- **Dark / Light Theme** — Automatic theme switching.

## Installation

### macOS (Homebrew)

```bash
brew tap delibae/claude-prism
brew install --cask claude-prism
```

### macOS / Windows / Linux

Download the latest build from [GitHub Releases](https://github.com/delibae/claude-prism/releases):

| Platform | File | Install |
|:--------:|:----:|:--------|
| **macOS** (Apple Silicon) | `.dmg` | Open → drag to Applications |
| **Windows** (x64) | `.msi` / `.exe` | Run the installer |
| **Linux** (x64) | `.AppImage` | `chmod +x` and run |
| **Linux** (x64) | `.deb` | `sudo dpkg -i claude-prism_*.deb` |

> Claude AI features require the [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (`claude`) installed locally.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | **Tauri 2** + Rust |
| Frontend | **React 19** + TypeScript + Vite |
| Editor | **CodeMirror 6** |
| PDF | **MuPDF** (native) |
| LaTeX | **Tectonic** (embedded) |
| State | **Zustand** |
| UI | **Radix UI** + Tailwind CSS |
| Monorepo | **pnpm** + Turborepo |

## Project Structure

```
claude-prism/
├── apps/
│   ├── desktop/           # Tauri desktop app (main)
│   │   ├── src/           # React frontend
│   │   └── src-tauri/     # Rust backend
│   ├── web/               # Next.js web app (legacy)
│   └── latex-api/         # LaTeX compilation API (Hono)
├── homebrew/              # Homebrew Cask formula
├── .github/workflows/     # CI/CD (build + release)
├── biome.json             # Linter config
└── turbo.json             # Turborepo config
```

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://rustup.rs/) (stable)
- macOS: `brew install icu4c harfbuzz pkg-config`

### Setup

```bash
git clone https://github.com/delibae/claude-prism.git
cd claude-prism
pnpm install
```

### Run

```bash
# Desktop app (Tauri dev mode)
pnpm dev:desktop

# Web app (legacy)
pnpm dev:web
```

### Build

```bash
pnpm build:desktop
```

### Lint

```bash
pnpm lint          # check
pnpm lint:fix      # auto-fix
```

## Contributing

Contributions are welcome! Please use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`).

## License

[MIT](./LICENSE)
