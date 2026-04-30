<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="DevPrism" />
</p>

<h1 align="center">DevPrism</h1>

<p align="center">
  An offline-first scientific writing workspace powered by Gemini and Ollama.<br/>
  LaTeX + Python + 100+ scientific skills — runs on your desktop.
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo/main.webp" alt="DevPrism Demo" width="800" />
</p>

<p align="center">
  <a href="https://github.com/bharathvbcr/DevPrism">
    <img src="https://img.shields.io/badge/Website-devprism.dev-blue?style=flat-square&logo=googlechrome&logoColor=white" alt="Website" />
  </a>&nbsp;
  <a href="https://github.com/bharathvbcr/DevPrism/releases/latest/download/DevPrism-macOS.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Apple_Silicon)-black?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS (Apple Silicon)" />
  </a>&nbsp;
  <a href="https://github.com/bharathvbcr/DevPrism/releases/latest/download/DevPrism-macOS-Intel.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Intel)-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS (Intel)" />
  </a>&nbsp;
  <a href="https://github.com/bharathvbcr/DevPrism/releases/latest/download/DevPrism-Windows-setup.exe">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" />
  </a>&nbsp;
  <a href="https://github.com/bharathvbcr/DevPrism/releases/latest/download/DevPrism-Linux.AppImage">
    <img src="https://img.shields.io/badge/Download-Linux_(AppImage)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux" />
  </a>
</p>
<p align="center">
  <a href="https://github.com/bharathvbcr/DevPrism/releases">
    <img src="https://img.shields.io/github/v/release/bharathvbcr/DevPrism?style=flat-square&label=Latest%20Release&color=green" alt="Latest Release" />
  </a>
</p>

---

## Why DevPrism?

[OpenAI Prism](https://openai.com/prism/) is a cloud-based LaTeX workspace — all your files and data must be uploaded to OpenAI's servers to use it.

DevPrism is a **local-first** alternative — your files are stored on your disk, compiled offline, and edited locally. AI features run via Gemini API or locally with Ollama.

| | OpenAI Prism | DevPrism |
|---|:---:|:---:|
| AI Model | GPT-5.2 | **Gemini 1.5 / Ollama / Llama 3** |
| Runtime | Browser (cloud) | **Native desktop (Tauri 2 + Rust)** |
| LaTeX | Cloud compilation | **Tectonic (embedded, offline)** |
| Python Environment | — | **Built-in uv + venv — one-click scientific Python setup** |
| Scientific Skills | — | **100+ domain skills (bioinformatics, cheminformatics, ML, ...)** |
| Getting Started | Account setup required | **Install and go — template gallery + project wizard** |
| Version Control | — | **Git-based history with labels & diff** |
| Source Code | Proprietary | **Open source (MIT)** |

### Data & Privacy

DevPrism stores and compiles your documents locally — nothing is uploaded to a remote server for storage. When using cloud AI, **prompts and file contents are sent to the provider's API (e.g. Gemini)**. For 100% privacy, use **Ollama** for local inference.

---

## Features

### Python Environment (uv)
DevPrism integrates [uv](https://docs.astral.sh/uv/) — the fast Python package manager — directly into the app. One click to install uv, one click to create a project-level virtual environment. The Dev Engine automatically uses the `.venv` when running Python code, so you can generate plots, run analysis scripts, and process data without leaving the editor.

<p align="center">
  <img src="./assets/demo/python.webp" alt="Python Environment" width="600" />
</p>

### 100+ Scientific Skills
Browse and install domain-specific skills — curated prompts and tool configurations that give the Assistant deep knowledge in specialized fields:

| Domain | Skills |
|--------|--------|
| **Bioinformatics & Genomics** | Scanpy, BioPython, PyDESeq2, PySAM, gget, AnnData, ... |
| **Cheminformatics & Drug Discovery** | RDKit, DeepChem, DiffDock, PubChem, ChEMBL, ... |
| **Data Analysis & Visualization** | Matplotlib, Seaborn, Plotly, Polars, scikit-learn, ... |
| **Machine Learning & AI** | PyTorch Lightning, Transformers, SHAP, UMAP, PyMC, ... |
| **Clinical Research** | ClinicalTrials.gov, ClinVar, DrugBank, FDA, ... |
| **Scientific Communication** | Literature Review, Grant Writing, Citation Management, ... |
| **Multi-omics & Systems Biology** | scvi-tools, COBRApy, Reactome, Bioservices, ... |
| **And more** | Materials Science, Lab Automation, Proteomics, Physics, ... |

Skills are installed globally (`~/.devprism/skills/`) or per-project, and the Assistant automatically loads them when relevant.

<p align="center">
  <img src="./assets/demo/scientific.webp" alt="Scientific Skills" width="700" />
</p>

### Quick Start with Templates & Project Wizard
Pick a template (paper, thesis, presentation, poster, letter, etc.), give it a name, optionally describe what you're writing — DevPrism sets up the project and generates initial content with AI. Drag & drop reference files (PDF, BIB, images) and start writing immediately.

<p align="center">
  <img src="./assets/demo/starter.webp" alt="Template Gallery & Project Wizard" width="700" />
</p>

### AI Assistant
Chat with your assistant directly in the editor. Select between Gemini and Ollama models. Persistent sessions, tool use (file edit, bash, search), and extensible slash commands.

### History & Proposed Changes
Every save creates a snapshot in a local Git repository (`.devprism/history.git/`). Label important checkpoints, browse diffs between any two snapshots, and restore previous versions. When the assistant suggests edits, changes appear in a dedicated panel with visual diffs — accept or reject per chunk, or apply/undo all at once (`⌘Y` / `⌘N`).

<p align="center">
  <img src="./assets/demo/history.webp" alt="History & Proposed Changes" width="700" />
</p>

### Offline LaTeX Compilation
Tectonic is embedded directly in the app. Packages are downloaded once on first use and cached locally. After that, compilation works fully offline with no TeX Live installation required.

### Capture & Ask
Press `⌘X` to enter capture mode, drag to select any region in the PDF — the captured image is pinned to the chat composer so you can immediately ask about it. Great for asking about equations, figures, tables, or reviewer comments.

<p align="center">
  <img src="./assets/demo/capture_ask.webp" alt="Capture & Ask" width="700" />
</p>

### Live PDF Preview
Native MuPDF rendering with SyncTeX support — click a position in the PDF to jump to the corresponding source line. Supports zoom, text selection, and capture.

### Editor
CodeMirror 6 with LaTeX/BibTeX syntax highlighting, real-time error linting, find & replace (regex), and multi-file project support with auto-save.

### More
- **Zotero Integration** — OAuth-based bibliography management and citation insertion.

<p align="center">
  <img src="./assets/demo/zotero.webp" alt="Zotero Integration" width="300" />
</p>

- **Slash Commands** — Built-in (`/review`, `/init`) + custom commands from `.devprism/commands/`.
- **External Editors** — Open projects in Cursor, VS Code, Zed, or Sublime Text.
- **Dark / Light Theme** — Automatic switching.

---

## Installation

Download the latest build from [GitHub Releases](https://github.com/bharathvbcr/DevPrism/releases).

## Architecture

DevPrism is a Tauri 2 desktop app. The React/Vite frontend owns the editor, template gallery, PDF preview, settings, and agent chat UI. The Rust host owns local filesystem access, Tectonic compilation, SyncTeX, Git-backed project history, uv setup, scientific skill installation, Zotero OAuth, and the native app lifecycle.

Runtime data is local by default:

- Project history: `.devprism/history.git/`
- Project skills: `.devprism/skills/`
- User settings and global skills: `~/.devprism/`
- Project Python environment: `.venv/`

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full module map and [docs/RELEASE.md](./docs/RELEASE.md) for GitHub build and release deployment.

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm --filter @devprism/desktop test
pnpm --filter @devprism/desktop build
```

Native desktop packaging is run with:

```bash
pnpm build
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and guidelines.

## Acknowledgments

This project started from [Open Prism](https://github.com/assistant-ui/open-prism) by [assistant-ui](https://github.com/assistant-ui).

## License

[MIT](./LICENSE)
