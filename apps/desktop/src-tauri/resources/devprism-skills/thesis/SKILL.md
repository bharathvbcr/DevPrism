---
name: thesis
description: "Use when authoring or compiling a long-form thesis, dissertation, or other multi-chapter document split across many files. Examples: \"start my PhD thesis\", \"set up a multi-chapter dissertation\", \"add a new chapter to my thesis\", \"compile the whole thesis with tectonic\", \"cross-reference a figure in another chapter\", \"build my thesis frontmatter and bibliography\"."
---

# Thesis & Dissertation Authoring

A LaTeX skill for long-form, multi-chapter documents (theses, dissertations, books).
It scaffolds a master document plus one file per chapter, builds frontmatter
(title page, abstract, acknowledgements, ToC, lists of figures/tables), manages a
large shared bibliography, supports cross-references across chapters with `cleveref`,
and compiles everything locally with `tectonic`.

## When to Use

- "Set up a thesis / dissertation project."
- "Create the title page, abstract, and table of contents for my thesis."
- "Add a new chapter file and \include it in the master."
- "I need to cite the same paper from several chapters."
- "Reference Figure X from Chapter 2 inside Chapter 4."
- "Compile the whole thesis to PDF with tectonic."
- "My thesis is slow to compile — how do I rebuild just one chapter?"

Do NOT use this for a single short paper or a two-page note — a one-file
`article` document is simpler. This skill is for documents large enough to split
into separate chapter files.

## Workflow

Follow these steps in order. Keep each step small and explicit.

1. **Create the project layout.** A thesis is several files in one folder:
   ```
   thesis.tex            <- master document (compile THIS one)
   chapters/
     introduction.tex
     background.tex
     method.tex
     results.tex
     conclusion.tex
   frontmatter/
     abstract.tex
     acknowledgements.tex
   appendices/
     appendix-a.tex
   references.bib        <- one shared bibliography for the whole thesis
   figures/              <- put images here
   ```
   Copy `templates/thesis.tex` to the project root as `thesis.tex`.
   Copy `templates/chapter-template.tex` once per chapter into `chapters/`.

2. **Fill in the title page.** Open `thesis.tex` and edit the variables near the
   top (`\title`, `\author`, `\degree`, `\department`, `\university`, `\thesisyear`).
   Do not touch the package list unless a build error tells you a package is missing.

3. **Write the frontmatter.** Put one paragraph per file:
   - `frontmatter/abstract.tex` — 150-350 words summarising the whole thesis.
   - `frontmatter/acknowledgements.tex` — short thanks.
   These are pulled in by `\input` in `thesis.tex`. The ToC, list of figures,
   and list of tables are generated automatically — do not write them by hand.

4. **Add chapters one at a time.** For each chapter:
   - Create `chapters/<name>.tex` from `templates/chapter-template.tex`.
   - Add a line `\include{chapters/<name>}` in the `\mainmatter` area of `thesis.tex`,
     in reading order. Use `\include` (NOT `\input`) for chapters — it starts each
     chapter on a new page and enables partial rebuilds (see step 8).
   - Give the chapter a unique label: `\chapter{Title}\label{ch:name}`.

5. **Manage one shared bibliography.** Keep every reference in a single
   `references.bib`. Each entry needs a unique key (e.g. `smith2020learning`).
   Cite with `\cite{key}` or `\textcite{key}` from any chapter. Because all chapters
   share one `.bib` and one master compile, the same key works everywhere and the
   reference list appears once at the end. To find a key, search `references.bib`
   for the author surname before adding a duplicate.

6. **Cross-reference across chapters with cleveref.** Label things once:
   - Chapters: `\label{ch:method}`
   - Sections: `\label{sec:setup}`
   - Figures: `\label{fig:pipeline}`
   - Tables: `\label{tab:results}`
   - Equations: `\label{eq:loss}`
   Reference them from ANY chapter with `\cref{...}` (lowercase, in-sentence:
   "as shown in \cref{fig:pipeline}") or `\Cref{...}` (start of sentence).
   `cleveref` adds the word ("Figure", "Chapter", "Table") automatically — do not
   type the word yourself.

7. **Compile with tectonic.** From the project root run:
   ```
   tectonic -X compile thesis.tex
   ```
   or, on older tectonic:
   ```
   tectonic thesis.tex
   ```
   Tectonic runs LaTeX, BibTeX/biber, and the needed extra passes automatically and
   downloads any missing TeXLive packages into its cache the first time (after that
   it works fully offline). Output is `thesis.pdf` in the same folder.

8. **Use incremental builds while drafting.** A full thesis is slow to recompile.
   To preview just one chapter, set `\includeonly{chapters/method}` in `thesis.tex`
   (right after `\begin{document}` area) so only that chapter is processed; page
   numbers and cross-references from other chapters are reused from the last full
   build via the `.aux` files. Remove the `\includeonly` line for the final build so
   the whole document, ToC, and bibliography are correct.

9. **Final check before sharing.** Remove `\includeonly`, run the compile command
   twice (so the ToC, lists, and `cleveref`/cite numbers settle), and confirm there
   are no "undefined reference" or "citation undefined" warnings in the output.

## Templates

- **`templates/thesis.tex`** — The master document. Use it once per thesis as the
  root file you compile. It sets `\documentclass{report}`, loads lightweight packages,
  defines the title-page variables, builds the title page / abstract /
  acknowledgements / ToC / list of figures / list of tables, `\include`s the chapters,
  adds appendices, and prints the bibliography. Edit the variables and the
  `\include` list; leave the structure alone.

- **`templates/chapter-template.tex`** — A single chapter scaffold. Copy it into
  `chapters/` once per chapter, rename it, set the `\chapter{...}` title and a unique
  `\label{ch:...}`, then write content. It shows a labelled section, a figure with a
  label, a table with a label, a citation, and a `\cref` cross-reference so the patterns
  are obvious. It has NO preamble of its own — it is meant to be `\include`d by
  `thesis.tex`.

## Tips & Conventions

- **Label prefixes keep references readable:** `ch:` chapters, `sec:` sections,
  `fig:` figures, `tab:` tables, `eq:` equations, `app:` appendices. Always label
  *after* the caption (`\caption{...}` then `\label{...}`) or the number will be wrong.
- **One concept per chapter file.** Smaller files compile and diff faster and let
  `\includeonly` isolate your current chapter.
- **Never hand-number anything.** Let LaTeX number chapters, figures, equations, and
  citations. Refer to them only through labels and `\cref`.
- **Keep the preamble in one place.** All `\usepackage` lines live in `thesis.tex`.
  Chapter files must not load packages or set the document class.
- **Figures go in `figures/`** and are included with `\includegraphics{figures/name}`
  (no extension needed — tectonic picks the right one).
- **Consistent styling:** use `\chapter`, `\section`, `\subsection` only; avoid manual
  `\vspace`/`\textbf` headings so the ToC stays correct.
- **Commit `.bib` and `.tex`, ignore build artefacts** (`.aux`, `.log`, `.toc`,
  `.lof`, `.lot`, `.bbl`, `.out`, `.pdf`).

## Offline / Local-LLM Notes

- Everything here runs offline. Tectonic caches packages on first use; after that no
  internet is needed. There are no cloud services, APIs, or accounts.
- When asking the local model (Ollama: llama3 / qwen) for help, work **one chapter or
  one section at a time** — do not paste the whole thesis. Give it just the relevant
  `chapters/<name>.tex` plus the abstract for context. Small models lose track of very
  long inputs.
- Good local-model prompts are short and explicit, e.g. "Rewrite this paragraph to be
  clearer, keep all `\cite` and `\cref` commands unchanged" or "Suggest a `\label` for
  this figure using the `fig:` prefix."
- Ask the model NOT to invent citation keys. It should only use keys that already exist
  in `references.bib`; if it needs a new source, have it emit a `TODO: add bibtex for ...`
  comment so you can add the real entry yourself.
- If a compile fails, paste only the first error line from the tectonic output to the
  model — the first error usually causes the rest. Fix it, then recompile.
