---
name: project-space
description: "Use when a user wants to organize, group, or scaffold multiple related DevPrism projects under a shared space with a default local model and attached skills. Examples: \"organize my projects\", \"set up a project space\", \"group related papers\", \"create a space for my job applications\", \"share a bibliography across my thesis chapters\"."
---

# Project Space

A **Project Space** in DevPrism groups related projects together so they share a
default local model, a curated set of skills, common conventions, and reusable
content. Use a space to keep everything for one research topic, one deliverable
type, or one collaborator in a single, consistent place.

Because DevPrism is **offline-first**, every space points at a local **Ollama**
model rather than a hosted API. A space is the unit where you decide "for this
whole group of projects, use *this* model and *these* skills by default."

## When to Use

Reach for this skill when the user says things like:

- "organize my projects" / "my workspace is a mess, group these together"
- "set up a project space" / "create a new space for ..."
- "group related papers" (e.g. all papers for one grant or research thread)
- "I have several resumes and cover letters — put them in one place"
- "share one bibliography across my thesis chapters"
- "make all my conference submissions use the same model and templates"
- "what model and skills should this group of projects use by default?"

If the user only has a single, standalone project, they probably don't need a
space yet — suggest one once they have two or more related projects.

## Workflow

1. **Decide how to slice projects into spaces.** Pick the axis that matches how
   the user actually works:
   - **By topic / research thread** — e.g. `protein-folding`, `climate-models`.
     Best when papers, slides, and notes all share a literature base.
   - **By deliverable type** — e.g. `job-applications` (resumes + cover letters),
     `talks` (all beamer decks).
   - **By collaborator or venue** — e.g. `lab-smith`, `neurips-2026`.
   Prefer a small number of broad spaces over many tiny ones; a project can
   always move later.

2. **Name the space.** Use a short, lowercase, hyphenated slug
   (`research-protein-folding`, `job-search-2026`). The name becomes the folder
   and the `name` field in the space config.

3. **Pick the default Ollama model.** Choose one local model for the whole space
   so output style stays consistent. Match the model to the work:
   - Long-form scientific prose / manuscripts: a larger instruct model.
   - Quick edits, resumes, slide bullets: a smaller, faster model.
   Leave `defaultModel` empty (`""`) to inherit the app-wide default, or set it
   explicitly (e.g. `"llama3.1:8b"`). Confirm the model is pulled in Ollama.

4. **Attach skills.** Decide which DevPrism skills auto-install for every project
   in the space. Pick from the available skill folder names:
   - `resume-cv` — resumes and CVs.
   - `statement-authoring` — personal statements and SOPs.
   - `manuscript-paper` — journal/conference papers.
   - `latex-toolkit` — general LaTeX helpers (always useful).
   - `thesis` — multi-chapter theses/dissertations.
   - `beamer-slides` — Beamer presentation decks.
   Put the chosen folder names in the `skillIds` array. For a research space you
   might use `["manuscript-paper", "latex-toolkit", "beamer-slides"]`; for a job
   space, `["resume-cv", "latex-toolkit"]`.

5. **Write the space config.** Create the space's persisted config from
   `templates/space-config.example.json`, filling in `id`, `name`, `color`,
   `defaultProvider` (`"ollama"`), `defaultModel`, and `skillIds`.

6. **Write the space README.** Copy `templates/space-readme.md` into the space
   root and fill in the `{{PLACEHOLDER}}` fields: purpose, the list of projects,
   shared conventions, and the default model/skills.

7. **Establish shared structure.** Set conventions every project in the space
   follows (see Tips below): a shared `.bib`, a naming scheme, and where common
   assets live. Apply them as each new project is created.

8. **Cross-reference between projects.** When a project reuses content from a
   sibling (a figure, a methods paragraph, a citation key), point to the source
   project so it stays the single source of truth instead of copy-pasting.

## Templates

This skill bundles two starter files in `templates/`:

- **`space-readme.md`** — A README for the space root. It documents the space's
  purpose, lists each project with a one-line description, records the shared
  conventions (bibliography, naming, assets), and states the default model and
  attached skills. Uses `{{SPACE_NAME}}`-style placeholders to fill in.

- **`space-config.example.json`** — An example of the per-space config DevPrism
  persists. Shows the exact field shape (`id`, `name`, `color`,
  `defaultProvider`, `defaultModel`, `skillIds`) with realistic example values
  so you can produce a valid config for a new space.

## Tips & Conventions

- **One shared bibliography.** Keep a single `references.bib` at the space root
  and have each project's LaTeX reference it (or symlink/copy on build). This
  avoids divergent citation keys across sibling projects.
- **Consistent naming.** Use a predictable project slug scheme within a space,
  e.g. `<space>-<deliverable>-<short-name>` (`folding-paper-msa`,
  `folding-slides-defense`).
- **Shared assets folder.** Put logos, style files (`.cls`/`.sty`), and reused
  figures in a space-level `assets/` so projects don't each carry a copy.
- **Keep skill sets lean.** Attach only the skills a space actually needs; extra
  skills add noise to every project. `latex-toolkit` is the common baseline.
- **One model per space.** A single default model keeps tone and formatting
  consistent across the space; override per-project only when truly needed.
- **Color-code spaces.** Give each space a distinct `color` so it's easy to tell
  apart in the DevPrism UI.

## Offline / Local-LLM Notes

- DevPrism runs **fully offline**: `defaultProvider` is always `"ollama"` and the
  model runs locally — no network calls, no API keys.
- Before relying on `defaultModel`, confirm it's pulled locally (`ollama pull
  <model>` / `ollama list`). A missing model fails offline with no fallback.
- Prefer a model that fits comfortably in available RAM/VRAM; an oversized model
  will be slow or fail to load. Smaller models are fine for resumes and slides.
- LaTeX is compiled locally with **tectonic** — no internet needed for builds,
  but the first tectonic run may need to have fetched packages beforehand.
- All space data (config, README, bibliography, assets) lives on disk and is
  portable: copy the space folder to move or back up the whole group.
