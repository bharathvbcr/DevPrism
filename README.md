<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="ClaudePrism" />
</p>

<h1 align="center">ClaudePrism</h1>

<p align="center">
  A private, offline-first scientific writing workspace powered by Claude.<br/>
  LaTeX + Python + 100 scientific skills — all running locally on your machine.
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo.png" alt="ClaudePrism Demo" width="800" />
</p>

<p align="center">
  <a href="https://claudeprism.delibae.dev?utm_source=github&utm_medium=readme&utm_campaign=launch_v054">Website</a> ·
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_aarch64.dmg">macOS</a> ·
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_x64-setup.exe">Windows</a> ·
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_amd64.deb">Linux</a> ·
  <a href="https://github.com/delibae/claude-prism/releases">All Releases</a>
</p>

---

## Why ClaudePrism?

[OpenAI Prism](https://openai.com/prism/) is a cloud-based LaTeX workspace for scientists — free, powerful, but **your unpublished research lives on OpenAI's servers**. Experts have raised concerns about intellectual property exposure and whether OpenAI could claim rights over researcher data. By default, content may be used to train future models unless you opt out.

ClaudePrism takes a different approach: **everything runs locally on your machine.**

| | OpenAI Prism | ClaudePrism |
|---|:---:|:---:|
| AI Model | GPT-5.2 (cloud) | **Claude Opus / Sonnet / Haiku (local CLI)** |
| Runtime | Browser (cloud) | **Native desktop (Tauri 2 + Rust)** |
| LaTeX | Cloud compilation | **Tectonic (embedded, offline)** |
| Python Environment | — | **Built-in uv + venv — one-click scientific Python setup** |
| Scientific Skills | — | **100+ domain skills (bioinformatics, cheminformatics, ML, ...)** |
| Getting Started | Account setup required | **Install and go — template gallery + project wizard** |
| Version Control | — | **Git-based history with labels & diff** |
| Data Privacy | Cloud storage, [opt-out available](https://help.openai.com/en/articles/8983082-how-do-i-turn-off-model-training-to-stop-openai-training-models-on-my-conversations) | **Local execution, [opt-out available](https://code.claude.com/docs/en/data-usage)** |
| Source Code | Proprietary | **Open source (MIT)** |

### Your Research, Your Machine

ClaudePrism invokes **Claude Code** as a local subprocess. Your documents stay on disk — only prompts are sent to the Claude API for inference.

**How the two compare on data:**

| | OpenAI Prism | ClaudePrism (via Claude Code) |
|---|---|---|
| Where documents live | OpenAI cloud servers | **Your local disk only** |
| Model training opt-out | [Available](https://help.openai.com/en/articles/8983082-how-do-i-turn-off-model-training-to-stop-openai-training-models-on-my-conversations) (Settings > Data Controls) | [Available](https://claude.ai/settings/data-privacy-controls) (Privacy Settings or API key) |
| **Data exposure after opt-out** | **Documents remain on OpenAI servers** | **Nothing leaves your machine** |
| **Feedback pitfall** | **👍/👎 sends entire conversation to training** | **No such mechanism** |
| Default training policy | ON (personal accounts) | ON (Consumer), **OFF** (API key / Team / Enterprise) |
| Data retention | ~30 days after opt-out | 30 days (opt-out) / 5 years (opt-in) |
| Zero data retention | Not available | Available on Enterprise |
| Telemetry | Cannot disable | `DISABLE_TELEMETRY=1` to fully disable |
| Source code | Proprietary | Open source — [audit it yourself](https://github.com/delibae/claude-prism) |

> **Both tools allow opting out of model training.** The critical difference is where your documents live. With Prism, your unpublished research exists on OpenAI's servers regardless of training settings. With ClaudePrism, files never leave your machine — only prompts are sent for AI inference.

---

## Features

### Python Environment (uv)
ClaudePrism integrates [uv](https://docs.astral.sh/uv/) — the fast Python package manager — directly into the app. One click to install uv, one click to create a project-level virtual environment. Claude Code automatically uses the `.venv` when running Python code, so you can generate plots, run analysis scripts, and process data without leaving the editor.

### 100+ Scientific Skills
Browse and install domain-specific skills from [K-Dense Scientific Skills](https://github.com/K-Dense-AI/claude-scientific-skills) — curated prompts and tool configurations that give Claude deep knowledge in specialized fields:

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

Skills are installed globally (`~/.claude/skills/`) or per-project, and Claude automatically loads them when relevant.

### Quick Start with Templates & Project Wizard
Pick a template (paper, thesis, presentation, poster, letter, etc.), give it a name, optionally describe what you're writing — ClaudePrism sets up the project and generates initial content with AI. Drag & drop reference files (PDF, BIB, images) and start writing immediately.

### Claude AI Assistant
Chat with Claude directly in the editor. Select between Sonnet, Opus, Haiku models with adjustable reasoning effort levels. Persistent sessions, tool use (file edit, bash, search), and extensible slash commands.

### Proposed Changes Review
When Claude suggests edits, changes appear in a dedicated panel with visual diffs. Accept or reject per chunk, or apply/undo all at once (`⌘Y` / `⌘N`). Your original content is always preserved until you decide.

### Git-Based History
Every save creates a snapshot in a local Git repository (`.claudeprism/history.git/`). Label important checkpoints, browse diffs between any two snapshots, and restore previous versions — all without leaving the app.

### Offline LaTeX Compilation
Tectonic is embedded directly in the app. Packages are downloaded once on first use and cached locally. After that, compilation works fully offline with no TeX Live installation required.

### Capture & Ask
Press `⌘X` to enter capture mode, drag to select any region in the PDF — the captured image is pinned to the chat composer so you can immediately ask Claude about it. Great for asking about equations, figures, tables, or reviewer comments.

### Live PDF Preview
Native MuPDF rendering with SyncTeX support — click a position in the PDF to jump to the corresponding source line. Supports zoom, text selection, and capture.

### Editor
CodeMirror 6 with LaTeX/BibTeX syntax highlighting, real-time error linting, find & replace (regex), and multi-file project support with auto-save.

### More
- **Zotero Integration** — OAuth-based bibliography management and citation insertion.
- **Slash Commands** — Built-in (`/review`, `/init`) + custom commands from `.claude/commands/`.
- **External Editors** — Open projects in Cursor, VS Code, Zed, or Sublime Text.
- **Dark / Light Theme** — Automatic switching.

---

## Installation

Download the latest build from [GitHub Releases](https://github.com/delibae/claude-prism/releases).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and guidelines.

## Acknowledgments

This project started from [Open Prism](https://github.com/assistant-ui/open-prism) by [assistant-ui](https://github.com/assistant-ui).

## License

[MIT](./LICENSE)
