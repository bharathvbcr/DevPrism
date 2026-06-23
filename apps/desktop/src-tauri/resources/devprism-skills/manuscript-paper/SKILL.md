---
name: manuscript-paper
description: "Use when authoring an academic journal or conference paper in LaTeX (IMRaD structure, BibTeX citations, figures, tables, equations, journal-class switching). Examples: \"start a new research paper\", \"set up a LaTeX article with abstract and references\", \"add a figure and cite it\", \"convert my draft to the IEEE journal class\", \"build a submission checklist for my manuscript\"."
---

# Academic Manuscript / Paper Authoring

Scaffold and write a journal- or conference-ready paper in LaTeX using the
IMRaD structure (Introduction, Methods, Results, and Discussion), with BibTeX
citations, figures, tables, and equations. Everything compiles locally with
`tectonic` (preferred) or `pdflatex` + `bibtex` — no internet required.

## When to Use

- "Start a new research paper / manuscript."
- "Set up a LaTeX article scaffold with title, abstract, keywords, and references."
- "Add a figure with a caption, label, and cross-reference."
- "Insert a professional table (booktabs) / a numbered equation."
- "Manage my BibTeX file and citations (`\cite`, `\citep`, `\citet`)."
- "Switch my paper to a specific journal/conference class later (IEEE, ACM, Elsevier)."
- "Give me a submission checklist (abstract length, figure resolution, references)."

## Workflow

Follow these steps in order. Keep edits small and compile often.

1. **Create the project files.** Copy the bundled templates into the working
   folder:
   - `article.tex` → `main.tex` (the manuscript).
   - `references.bib` → `references.bib` (the bibliography database).
   Confirm both sit in the same directory.

2. **Fill the front matter.** In `main.tex` edit `\title{}`, the `\author{}`
   block, `\date{}`, the `abstract` environment, and the `\textbf{Keywords:}`
   line. Keep the abstract to one paragraph (target 150–250 words; check the
   venue's limit).

3. **Write the IMRaD body.** Use the pre-stubbed sections in this order. One
   clear idea per paragraph:
   - `\section{Introduction}` — context, gap, contribution, paper roadmap.
   - `\section{Methods}` — enough detail to reproduce; cite tools/datasets.
   - `\section{Results}` — findings only (no interpretation); refer to figures/tables.
   - `\section{Discussion}` — interpret results, limitations, comparison to prior work.
   - `\section{Conclusion}` — restate contribution and future work.
   For theory-heavy papers you may add `\section{Related Work}` after the
   Introduction and merge Results into Discussion.

4. **Add citations.** Put each source as a BibTeX entry in `references.bib`
   (see the template for `@article`, `@book`, `@inproceedings` examples), then
   cite in text. With the template's `natbib` setup:
   - `\citep{key}` → parenthetical, "(Author, 2020)".
   - `\citet{key}` → textual, "Author (2020) showed…".
   - `\cite{key}` → plain numeric/author depending on the bib style.
   The `\bibliography{references}` line at the end pulls them in.

5. **Insert figures.** Use the `figure` environment with `graphicx`. Always set
   a `\label{fig:...}` right after the `\caption{}` and cross-reference with
   `Figure~\ref{fig:...}`. Example:
   ```latex
   \begin{figure}[t]
     \centering
     \includegraphics[width=0.8\linewidth]{figures/overview.pdf}
     \caption{System overview.}
     \label{fig:overview}
   \end{figure}
   ```
   Prefer vector PDF/EPS; for photos use 300+ DPI PNG/JPG.

6. **Insert tables.** Use `booktabs` rules (`\toprule`, `\midrule`,
   `\bottomrule`) — never vertical rules. Caption goes **above** the table.
   See the `table` example already in the template.

7. **Insert equations.** Use `amsmath`. Inline math with `$...$`; numbered
   display math with the `equation` environment and `\label{eq:...}`; multi-line
   with `align`. Reference as `Equation~\eqref{eq:...}`.

8. **Compile.** Run, from the project folder:
   ```
   tectonic main.tex
   ```
   Tectonic resolves the bibliography automatically. If using a classic
   TeX install instead:
   ```
   pdflatex main && bibtex main && pdflatex main && pdflatex main
   ```
   Fix the first error reported, then recompile (later errors are often cascades).

9. **Switch to a journal/conference class (when ready).** Do this LAST, after
   content is stable:
   - Replace `\documentclass{article}` with the venue class, e.g.
     `\documentclass[conference]{IEEEtran}`, `\documentclass{sn-jnl}` (Springer
     Nature), `\documentclass[acmsmall]{acmart}`, or an Elsevier `elsarticle`.
   - Move the venue `.cls` / `.bst` files into the project folder (most are
     bundled in TeX Live; if not, the publisher ships them in their template zip
     — add them offline).
   - Adjust the author block and bib style to match the class (`\bibliographystyle{IEEEtran}`
     etc.). Comment out `natbib` if the class loads its own citation handling.
   - Recompile and resolve class-specific warnings.

10. **Run the submission checklist** (see Tips) before exporting the final PDF.

## Templates

All template files live in `templates/` inside this skill folder.

- `templates/article.tex` — Journal-agnostic `article` scaffold. Loads
  `amsmath`, `graphicx`, `booktabs`, `hyperref`, and `natbib`. Contains the
  title/author/abstract/keywords front matter, all five IMRaD section stubs, a
  worked equation, a `booktabs` table, a figure block (commented so it compiles
  without an image present), example `\citep`/`\citet` calls, and the
  `\bibliography{references}` line. **Use as the starting `main.tex`.**

- `templates/references.bib` — A small BibTeX database with one `@article`, one
  `@book`, and one `@inproceedings` entry, each with all required fields filled
  in. **Use as the starting `references.bib`; replace the examples with real
  sources.**

## Tips & Conventions

- **Label prefixes** keep cross-refs readable: `sec:`, `fig:`, `tab:`, `eq:`.
  Always `\label` immediately after `\caption` (order matters for figures/tables).
- **Use `~` (non-breaking space)** before refs and citations: `Figure~\ref{...}`,
  `\citet{...}`, `Section~\ref{...}` — prevents awkward line breaks.
- **One sentence per source line** in the `.tex` makes diffs and local-LLM edits
  cleaner. LaTeX collapses single newlines into spaces.
- **Figures**: vector (PDF/EPS) for plots/diagrams; raster (300+ DPI) only for
  photos. Keep originals in `figures/`.
- **Citations**: every `\cite*` key must exist in `references.bib`, and every
  entry you cite must appear — run a compile and check for "undefined references"
  / "citation undefined" warnings.
- **Don't hand-number** sections, figures, equations, or references — let LaTeX
  do it via `\ref`/`\eqref`/`\cite`.

### Submission Checklist

- [ ] Abstract within the venue word/character limit (typically 150–250 words).
- [ ] Title, all authors, affiliations, and corresponding-author contact correct.
- [ ] Keywords present and within the allowed count.
- [ ] All figures cross-referenced in text and in order; captions self-contained.
- [ ] Figure resolution: vector where possible, raster ≥ 300 DPI; fonts embedded.
- [ ] All tables use `booktabs`, captioned above, referenced in text.
- [ ] Every equation that is referenced is numbered; unreferenced ones can be unnumbered.
- [ ] No undefined references or citations in the compile log; no "??" in the PDF.
- [ ] Every BibTeX entry has required fields; DOIs/URLs where applicable.
- [ ] Switched to the correct journal/conference class and bib style; page/length limit met.
- [ ] PDF compiles cleanly from scratch (`tectonic main.tex`) with no errors.

## Offline / Local-LLM Notes

- **Everything is local.** Compilation uses `tectonic` (bundled fonts/packages)
  or a local TeX Live; no package downloads or web services are needed at write
  time. Tectonic may fetch packages on first run if its cache is empty — pre-warm
  it once while online, then it works fully offline.
- **All packages used (`amsmath`, `graphicx`, `booktabs`, `hyperref`, `natbib`)
  ship with standard TeX Live / tectonic.** No exotic dependencies.
- **For a small local model (llama3/qwen via Ollama):** give it ONE task at a
  time — "write the Methods paragraph", "add a `\citep` for source X", "make a
  3-column booktabs table". Don't ask it to emit the whole paper at once.
- **Keep prompts grounded:** paste only the relevant section plus the exact
  template snippet you want it to mimic. The templates here are short on purpose
  so they fit in a small context window.
- **Citations are deterministic, not generative.** Have the model draft prose,
  but YOU (or a verify pass) confirm each `\cite` key exists in `references.bib`
  and the bibliographic fields are real — small models hallucinate references.
- **Compile after every model edit.** A quick `tectonic main.tex` catches broken
  braces, missing `\label`s, and undefined refs immediately.
