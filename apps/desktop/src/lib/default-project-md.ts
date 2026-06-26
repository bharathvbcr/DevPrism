// Single source of truth for the project-context document DevPrism scaffolds
// into new projects. Both CLAUDE.md (Claude Code) and AGENTS.md (the AGENTS.md
// convention / DevPrism's native local agent) are written from this same
// string, so the two can never drift apart. See default-claude-md.ts and
// default-agent-md.ts, which re-export this verbatim.
export const DEFAULT_PROJECT_INSTRUCTIONS_MD = `# DevPrism LaTeX Project

Academic writing workspace powered by DevPrism. You are assisting with a LaTeX document project.

## Environment

- **LaTeX Engine**: Selectable in Settings — **Tectonic** (default; bundled, works offline, auto-installs packages and fonts, no manual \`tlmgr\`) or **TeXLive** (uses your locally installed TeX distribution).
- **Python**: Available via \`uv\` with project-local \`.venv/\`. Use \`uv pip install <pkg>\` to add packages, \`uv run <script>\` to execute.
- **Build Directory**: \`.prism/build/\` (persistent, do not modify directly)
- **Version History**: \`.claudeprism/\` (automatic snapshots, do not modify)

## Project Structure

\`\`\`
.
├── main.tex              # Primary document (or custom-named .tex)
├── references.bib        # Bibliography (if applicable)
├── attachments/           # Reference files (PDFs, images, data)
├── .venv/                 # Python virtual environment (auto-detected)
└── figures/               # Generated figures and plots
\`\`\`

## Commands

\`\`\`bash
# Python (data analysis, plotting, computation)
uv pip install numpy matplotlib pandas scipy     # Install packages
uv run python script.py                          # Run a script

# LaTeX is compiled automatically by DevPrism — no manual build commands needed.
\`\`\`

## Writing Guidelines

- Edit \`.tex\` files directly. DevPrism auto-compiles and shows a live PDF preview.
- Use \`\\input{filename}\` or \`\\include{filename}\` to split large documents into multiple files.
- Place images in a \`figures/\` directory and reference with \`\\includegraphics{figures/name}\`.
- For bibliography, add entries to \`references.bib\` and cite with \`\\cite{key}\`.
- When adding new packages, add \`\\usepackage{pkg}\` to the preamble. With Tectonic these install automatically; under TeXLive, install any missing package into your local TeX distribution.

## Scientific Skills

If scientific skills are installed (\`~/.claude/skills/\` or \`.claude/skills/\`), you have access to 100+ domain-specific tools:

- **Data Analysis**: pandas, numpy, scipy, statsmodels, scikit-learn, polars
- **Visualization**: matplotlib, seaborn, plotly (save figures to \`figures/\` directory)
- **Bioinformatics**: scanpy, biopython, pydeseq2, pysam
- **Chemistry**: rdkit, datamol, deepchem
- **Symbolic Math**: sympy
- **Statistical Modeling**: pymc, statsmodels, scikit-survival

When generating figures with Python, always:
1. Save to \`figures/<descriptive-name>.pdf\` (vector) or \`.png\` (raster, 300 dpi)
2. Add corresponding \`\\includegraphics\` in the \`.tex\` file
3. Use publication-quality formatting (proper labels, legends, font sizes)

## Your project context (master / instruction files)

DevPrism auto-discovers your project's context at the start of every task — you
don't need to re-paste your details or turn them into a skill. Drop a master file
at the project root and the agent reads it automatically:

- \`MASTER.md\` (or \`RESUME.md\`, \`CV.md\`, \`PROFILE.md\`, \`*.master.md\`) — your
  elaborate details (career history, target journal, author info, conventions).
- \`.devprism/instructions.md\` — standing instructions for this project.

The agent inlines a small master file, lists larger ones (and \`main.tex\`,
\`references.bib\`, \`*.master.json\`) to open on demand, sees a project map, and
knows which installed skills to use. See \`docs/CONTEXT_FILES.md\`. (A *skill* is a
reusable procedure; a *master file* is your data — keep them separate.)

## Gotchas

- Tectonic always uses the XeTeX engine (strong Unicode/font support out of the box). With TeXLive the engine is selectable — add \`% !TEX program = xelatex\` (or \`lualatex\` / \`pdflatex\`) at the top of \`main.tex\`.
- Do NOT create or modify files in \`.prism/\`, \`.claudeprism/\`, or \`.venv/\` — these are managed automatically.
- When modifying LaTeX, ensure matching \`\\begin{}\` / \`\\end{}\` pairs — mismatches cause hard-to-debug compile errors.
- Large tables and figures should use \`\\begin{table}[htbp]\` / \`\\begin{figure}[htbp]\` for proper float placement.
- If the user provides reference files in \`attachments/\`, review them before writing — they contain key context.
`;
