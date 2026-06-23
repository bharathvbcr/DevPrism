---
name: beamer-slides
description: "Use when building a talk, presentation, or slide deck in LaTeX Beamer, or turning a paper/manuscript into slides. Examples: \"make slides for my paper\", \"create a Beamer presentation\", \"turn these results into a talk\", \"build a slide deck with overlays and two columns\"."
---

# Beamer Slides (LaTeX Presentations)

Build clean, compile-ready LaTeX Beamer presentations entirely offline. This skill
provides a complete `slides.tex` scaffold and a step-by-step workflow for structuring
a talk, adding overlays/transitions, using columns, inserting figures, and compiling
locally with `tectonic`.

## When to Use

- "Make slides / a presentation / a talk in Beamer."
- "Turn my paper (or these results) into a slide deck."
- "I need a title frame, outline, sections, a two-column frame, and a figure frame."
- "Add `\pause` overlays / step-reveal a bulleted list."
- "Use the metropolis theme" or "give me a clean default theme."
- "Compile my slides locally without internet."

## Workflow

Follow these steps in order. Keep each frame about ONE idea.

1. **Copy the scaffold.** Start from `templates/slides.tex`. Place it in the working
   folder (or have the user open it). Do not invent a deck from a blank file; edit
   the template so it always compiles.

2. **Fill the metadata.** Set `\title`, `\subtitle`, `\author`, `\institute`, and
   `\date` near the top. Keep the title short (one line on the title frame).

3. **Choose a theme.** The default is `Madrid` (built into every TeXLive install, no
   extra fonts). If the user wants a modern look, switch to `metropolis` by following
   the commented block in the template. `metropolis` needs the `metropolis` theme
   package and a sans font; it is optional, so leave Madrid unless asked.

4. **Outline the talk first.** Decide the section list before writing slides. A good
   research talk is: Motivation -> Problem -> Method -> Results -> Conclusion. Create
   one `\section{...}` per major part. The template auto-prints a table of contents at
   each section via `\AtBeginSection`.

5. **One frame per idea.** For each point, add a `frame`. Give every frame a short
   `frametitle`. If a frame's content overflows the slide, split it into two frames
   rather than shrinking the font.

6. **Reveal content gradually with overlays.** Use `\pause` between bullets to step
   through a list, or `\only<2->{...}` / `\onslide<2->{...}` to show an element on a
   later click. Use `\alert<n>{...}` to highlight a word on a specific step. See the
   "Bulleted list with \pause" frame in the template.

7. **Use columns for side-by-side content** (text + figure, or two comparisons). Wrap
   content in a `columns` environment with two `column` blocks. See the two-column
   frame in the template. Keep each column narrow (about `0.48\textwidth`).

8. **Insert figures.** Put image files next to the `.tex` file. Use
   `\includegraphics[width=0.7\textwidth]{figure}` inside a centered frame. The
   template includes a figure frame that falls back to a generated placeholder box, so
   it compiles even before you have a real image. Replace the placeholder with your
   filename.

9. **Convert paper results into slides.** When given a paper/manuscript, map each
   section to slides:
   - Abstract / Intro -> 1 motivation frame + 1 problem-statement frame.
   - Methods -> 1-2 frames; show a diagram or a single key equation, not full
     derivations.
   - Each main Result/Table/Figure -> its own frame. Lift the figure or a 3-4 row
     summary table; state the takeaway in the frame title.
   - Discussion/Conclusion -> 1 "key takeaways" frame (3 bullets max) + thanks frame.
   Strip prose to phrases. A slide is a cue card for the speaker, not the paper text.

10. **Add the closing frame.** Keep the template's "Thank You" frame; add contact info
    or a one-line summary. Optionally add a backup/appendix section after it.

11. **Compile locally with tectonic.** Run:

    ```sh
    tectonic slides.tex
    ```

    This produces `slides.pdf` in the same folder, fully offline. If `tectonic` is not
    available, `pdflatex slides.tex` (run twice so the table of contents resolves)
    works with any TeXLive install. Open the PDF in presentation/full-screen mode.

12. **Review against presenter tips** (below) before finishing. Trim any frame with
    more than ~6 lines of text.

## Templates

- **`templates/slides.tex`** — Complete Beamer presentation scaffold. Use it as the
  starting point for any deck. It contains, in order:
  - A title frame (`\titlepage`) with metadata.
  - An outline frame (table of contents) plus an auto-TOC at each section.
  - Section frames showing how to split a talk into parts.
  - A **two-column** frame (text beside a list/figure slot).
  - A **figure** frame using `\includegraphics` with a self-contained placeholder so it
    compiles with no image present.
  - A **bulleted list with `\pause` overlays** demonstrating step reveals, `\only`,
    `\onslide`, and `\alert`.
  - A **closing / thanks** frame.

  The file uses only the `Madrid` built-in theme plus lightweight, standard TeXLive
  packages (`graphicx`, `booktabs`, `tikz`). All optional pieces (the `metropolis`
  theme, custom fonts) are commented out and guarded so the template compiles out of
  the box. Edit the metadata and frame bodies; do not remove the preamble guards.

## Tips & Conventions

- **Keep text minimal.** Bullets are phrases, not sentences. Aim for <= 6 lines and
  <= 40 words per slide. The audience listens to you; the slide is a cue, not a script.
- **One idea per frame.** If you need "and", consider two frames.
- **Big, readable figures.** Prefer one large figure over several small ones. Label
  axes; remove chartjunk.
- **Use overlays sparingly.** Step-reveal long lists or build up a diagram; do not
  animate every line — it slows the talk.
- **Consistent verb tense and parallel bullet structure** read better on slides.
- **Section dividers** (auto-TOC) help the audience track where they are; keep section
  count to 4-6.
- **Compile early and often** with `tectonic slides.tex` to catch LaTeX errors before
  the deck grows large.
- **Frame breaks:** for a rare long frame, use `\begin{frame}[allowframebreaks]` so
  Beamer auto-splits it; prefer manual splitting for talks.
- **No `\pause` inside `columns`** can misbehave with some themes — if overlays inside
  columns look wrong, use `\onslide<n->` on each column's content instead.

## Offline / Local-LLM Notes

- Everything here is **offline**: `tectonic` downloads packages once into a local
  cache, then compiles with no network. `pdflatex` from a local TeXLive needs no
  network at all. No cloud or paid services are used.
- The template depends only on packages shipped with standard TeXLive
  (`graphicx`, `booktabs`, `tikz`, the `Madrid` theme). The optional `metropolis`
  theme is the only non-core piece and is commented out by default.
- **For a small local model (Ollama llama3/qwen):** work one frame at a time. Do not
  load the whole paper into context. Ask the user for ONE section or ONE result, draft
  ONE frame following the matching example in `slides.tex`, then move on. This keeps
  prompts short and avoids context overflow.
- When unsure of LaTeX syntax, copy the exact pattern from the corresponding frame in
  `templates/slides.tex` rather than generating new macros — the template is known to
  compile.
- After any edit, instruct the user (or run, if you have shell access) `tectonic
  slides.tex` and report the first error line if compilation fails. Common fixes:
  unmatched `{`, a `\includegraphics` filename that does not exist, or a `column`
  block missing its width argument.
