---
name: latex-toolkit
description: "Use when writing, structuring, or fixing LaTeX documents in DevPrism — document setup, math, tables, figures, TikZ basics, and compile-error troubleshooting with tectonic. Examples: \"how do I make a table in LaTeX\", \"my document won't compile / Undefined control sequence\", \"insert a figure\", \"add an equation\", \"fix Missing $ inserted\", \"set up a new .tex file\", \"compile this locally with tectonic\"."
---

# LaTeX Toolkit

The go-to reference for "how do I do X in LaTeX" inside DevPrism. Covers starting a
document, copy-pasteable recipes for math / tables / figures / TikZ, and a
troubleshooting map from common tectonic/LaTeX error messages to concrete fixes.
Everything here works fully offline and compiles with `tectonic` (no internet, no
cloud services).

## When to Use

- "Start a new LaTeX document" / "give me a document skeleton".
- "How do I write this equation / matrix / aligned equations?"
- "Make a table" / "professional table with rules" / "table is too wide".
- "Insert a figure" / "place an image" / "reference a figure by number".
- "Draw a simple diagram with TikZ."
- "My document won't compile" / any tectonic or LaTeX error message:
  *Undefined control sequence*, *File `xxx.sty' not found*, *Missing $ inserted*,
  *Runaway argument / unbalanced braces*, *Overfull \hbox*, *Undefined reference*.
- "How do I compile locally with tectonic?"

## Workflow

Follow these steps. Keep edits small and recompile often.

1. **Identify the request type**: document setup, a content recipe (math/table/figure/TikZ),
   or an error fix. For errors, jump to step 6.

2. **Start from the skeleton.** Create the main file from the skeleton in
   `## Templates` below. Put the shared preamble in its own file and pull it in with
   `\input{preamble}` so every document shares one configuration.

   ```latex
   \documentclass[11pt]{article}
   \input{preamble}   % loads amsmath, graphicx, booktabs, hyperref, cleveref, ...

   \title{My Paper}
   \author{Author Name}
   \date{\today}

   \begin{document}
   \maketitle
   \section{Introduction}
   Hello, world.
   \end{document}
   ```

3. **Add math** with the recipes below. Inline math uses `$...$`; display math uses
   `\[ ... \]` or an `equation`/`align` environment. Never put display math constructs
   (`\frac`, `^`, `_`, `\sum`) in plain text — they must be inside math mode.

   ```latex
   % Inline
   The mass--energy relation is $E = mc^2$.

   % Single numbered display equation
   \begin{equation}\label{eq:euler}
     e^{i\pi} + 1 = 0
   \end{equation}
   Reference it with \cref{eq:euler}.

   % Multi-line aligned equations (align from amsmath)
   \begin{align}
     f(x) &= (x+1)^2 \\
          &= x^2 + 2x + 1
   \end{align}

   % Fraction, sum, integral, matrix
   \[
     S = \sum_{k=1}^{n} \frac{1}{k^2}, \qquad
     \int_0^1 x^2 \, dx = \frac{1}{3}, \qquad
     A = \begin{pmatrix} a & b \\ c & d \end{pmatrix}
   \]
   ```

4. **Add a table** using `booktabs` (loaded by the preamble). Use `\toprule`,
   `\midrule`, `\bottomrule` — never vertical rules or `\hline` spam.

   ```latex
   \begin{table}[t]
     \centering
     \caption{Results on the validation set.}
     \label{tab:results}
     \begin{tabular}{l r r}
       \toprule
       Method      & Accuracy & Time (s) \\
       \midrule
       Baseline    & 0.812    & 12.4     \\
       Ours        & \textbf{0.901} & 9.8 \\
       \bottomrule
     \end{tabular}
   \end{table}
   ```
   Refer to it with `\cref{tab:results}`. If a table is too wide, see the Overfull
   fix in step 6.

5. **Add a figure.** `graphicx` is loaded by the preamble. Keep images beside the
   `.tex` file or in a `figures/` subfolder.

   ```latex
   \begin{figure}[t]
     \centering
     \includegraphics[width=0.6\linewidth]{figures/plot.pdf}
     \caption{A descriptive caption.}
     \label{fig:plot}
   \end{figure}
   ```
   Reference with `\cref{fig:plot}`. Prefer vector formats (`.pdf`, `.png`) that
   tectonic embeds without extra tools.

   **TikZ basics** (uncomment `\usepackage{tikz}` in the preamble first):

   ```latex
   \begin{tikzpicture}
     \draw[->] (0,0) -- (3,0) node[right] {$x$};
     \draw[->] (0,0) -- (0,2) node[above] {$y$};
     \draw[thick,blue] (0,0) .. controls (1,2) and (2,2) .. (3,0);
   \end{tikzpicture}
   ```

6. **Fix compile errors.** Read the *first* error tectonic prints (later errors are
   usually fallout). Map the message using the table in `## Tips & Conventions →
   Troubleshooting`. Apply one fix, recompile, repeat.

7. **Compile locally with tectonic** (offline, single command — see step in
   Tips & Conventions). After it succeeds, view the produced `main.pdf`.

## Templates

All bundled files live in this skill's `templates/` folder.

- **`templates/preamble.tex`** — A reusable, well-commented preamble loading
  `amsmath`, `amssymb`, `graphicx`, `booktabs`, `hyperref`, `geometry`, `microtype`,
  and `cleveref` (in the correct load order). Use it for **every** new document via
  `\input{preamble}` so all documents share one configuration. Optional packages
  (`tikz`, `siunitx`, `subcaption`) are present but commented out — uncomment only
  what you need to keep compiles fast. Copy this file next to your `main.tex` (or
  reference it by relative path).

  How to use:
  1. Save your document as `main.tex`.
  2. Put `templates/preamble.tex` next to it (rename to `preamble.tex`).
  3. Add `\input{preamble}` right after `\documentclass{...}`.

## Tips & Conventions

- **Load order matters.** `hyperref` should load late; `cleveref` must load *after*
  `hyperref`. The bundled preamble already does this — don't reorder it.
- **Use `\cref{}` / `\Cref{}`** (from `cleveref`) for all cross-references instead of
  writing "Figure~\ref{...}" by hand. It auto-inserts the right label ("Figure 3",
  "Table 2", "Equation 5") and handles capitalization.
- **Labels need a `\caption` first** in floats: put `\label` *after* `\caption`, or the
  reference number will be wrong.
- **Booktabs only**: no vertical lines, no double rules. It looks better and avoids
  alignment bugs.
- **Recompile may run twice**: cross-references and `cleveref` need two passes to
  resolve. tectonic does this automatically; if numbers show as `??`, just compile
  again.

### Compile locally with tectonic

From a terminal in the document's folder (works fully offline once packages are
cached):

```bash
tectonic main.tex
# produces main.pdf in the same folder
```

Useful flags:

```bash
tectonic --keep-logs main.tex     # keep the .log for debugging errors
tectonic --outdir build main.tex  # write outputs into ./build
tectonic -X compile main.tex      # explicit "compile" subcommand (newer tectonic)
```

### Troubleshooting — error message → fix

| Error message (tectonic / LaTeX)                         | Likely cause                                                        | Fix |
|----------------------------------------------------------|---------------------------------------------------------------------|-----|
| `Undefined control sequence` `\foo`                      | A command is misspelled, or its package isn't loaded.               | Check spelling of `\foo`. If it's a real command (e.g. `\includegraphics`, `\toprule`, `\cref`), add the package that defines it (`graphicx`, `booktabs`, `cleveref`) — the bundled preamble already covers these. Custom macros must be `\newcommand`'d before use. |
| `File 'xxx.sty' not found` / `LaTeX Error: ... not found`| Package isn't installed/available to tectonic.                      | Confirm the package name spelling in `\usepackage{xxx}`. Prefer the lightweight, TeXLive-standard packages used in the preamble. tectonic auto-downloads missing standard packages on first online run and caches them; once cached it works offline. If a package is unavailable offline, replace it with a standard alternative. |
| `Missing $ inserted`                                     | A math-only symbol (`_`, `^`, `\alpha`, `\frac`, `\sum`) appears in text mode. | Wrap the math in `$...$` (inline) or `\[...\]` (display). A bare underscore in text must be escaped as `\_`. |
| `Runaway argument?` / brace/`Paragraph ended before ... was complete` | Unbalanced `{ }` or a missing `\end{...}`.                          | Count braces and `\begin`/`\end` pairs around the reported line. Add the missing `}` or close the environment. An editor's bracket-matching helps locate it. |
| `Overfull \hbox (... too wide)`                          | A line/box can't fit the text width (long word, URL, wide table).   | Often cosmetic. To fix: rewrap text, add hyphenation hints (`\-`), wrap a wide table in `\resizebox{\linewidth}{!}{ ... }`, or shrink an image with `width=0.8\linewidth`. `microtype` (in the preamble) reduces most of these automatically. |
| `Reference 'x' undefined` / numbers show as `??`         | Label not defined yet, or only one compile pass ran.                | Recompile (cross-refs need two passes). Verify the `\label{x}` exists and is spelled exactly like the `\ref`/`\cref{x}`, and that it comes *after* the `\caption`. |
| `Missing \begin{document}`                               | Content placed in the preamble before `\begin{document}`.           | Move all text/sections to *after* `\begin{document}`. Only `\usepackage`, `\newcommand`, settings belong in the preamble. |
| `Environment xxx undefined`                              | Using `align`, `equation*`, `pmatrix`, etc. without `amsmath`.      | Ensure `\usepackage{amsmath}` is loaded (it is, in the preamble) and the environment name is spelled correctly. |
| `Unknown graphics extension` / image not found           | Wrong path or unsupported image format.                             | Use a path relative to the `.tex` file (e.g. `figures/plot.pdf`), and a supported format (`.pdf`, `.png`, `.jpg`). Don't include the extension twice. |

General debugging recipe: fix the **first** reported error, save, recompile, repeat.
Use `tectonic --keep-logs main.tex` and open `main.log` to find the line number that
triggered the failure.

## Offline / Local-LLM Notes

- **No internet required for content.** Every recipe and the preamble use only standard
  TeXLive packages. Once tectonic has cached the package bundle, compilation is fully
  offline.
- **No cloud / paid services.** Do not suggest Overleaf, ChatGPT plugins, web compilers,
  or any online tool. Compile locally with the `tectonic` command shown above.
- **Guidance for a small local model (Ollama llama3/qwen):** when asked to write or fix
  LaTeX, follow this short loop:
  1. Pick the matching recipe block above and copy it verbatim.
  2. Replace only the placeholder text (titles, labels, numbers) — keep the structure.
  3. For an error, read the first error line, find its row in the troubleshooting table,
     apply exactly that one fix, then recompile.
  4. Prefer small, single edits over rewriting the whole document; recompile after each.
- **Keep context small.** You usually only need the relevant recipe + the few lines
  around the error — you do not need the whole document in context to fix one error.
- **Prefer the lightweight packages** already in `templates/preamble.tex`. Avoid pulling
  in large or exotic packages a local setup may not have cached.
