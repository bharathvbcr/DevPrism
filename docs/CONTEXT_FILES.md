# Project context files (how the agent reads your project)

DevPrism's agent works like a coding agent: at the **start of every task** it
auto-discovers your project's context and acts on it — you don't have to paste
your details into the chat each time, and **you don't need to turn them into a
skill.**

## What the agent auto-discovers

When you open a project, the agent is given a compact **PROJECT CONTEXT** block
containing:

1. **Instruction files** — `CLAUDE.md` / `AGENTS.md` / `AGENT.md` (these are also
   read natively, so they're just listed as pointers).
2. **Master / profile files** — your elaborate details. The agent **inlines** a
   small one and **lists** larger ones to open on demand. Recognized names
   (case-insensitive), at the project root, under `.devprism/`, or under
   `context/`:
   - `MASTER.md`, `RESUME.md`, `CV.md`, `PROFILE.md`, `AUTHOR.md`, `BIO.md`
   - `*.master.md`, anything starting with `RESUME…`
   - `.devprism/instructions.md`, or any `.md` / `.txt` in `.devprism/` or `context/`
3. **Key data files** — `main.tex`, `master.tex`, `references.bib`,
   `master.bib`, `master.json`, `*.master.bib`, `*.master.json` (listed; the
   agent opens them as needed).
4. **A project map** — a compact file tree (managed/build dirs hidden).
5. **Installed skills** — the name + one-line description of every skill in
   `.claude/skills/`, so the agent knows which to use.

## Master file vs. skill — which do I use?

- **Master / context file** = *your data* (your CV history, the target journal,
  author info, project conventions). Drop a `MASTER.md` (or `RESUME.md`, …) in
  the project. The agent reads it automatically. **No skill needed.**
- **Skill** (`.claude/skills/<name>/SKILL.md`) = *a reusable procedure* (how to
  format an ATS resume, how to scaffold a manuscript). Use the bundled ones or
  create your own from **Environment → DevPrism skills**.

## Examples

**Resume project**
```
my-resume/
├── MASTER.md            ← your full career history, contact, preferences
├── cv.tex               ← the document being built
├── references.bib
└── .devprism/instructions.md   ← "always 1 page, moderncv, never invent roles"
```

**Manuscript project**
```
paper/
├── MASTER.md            ← target journal, author list, abstract limit, notes
├── main.tex
├── references.bib
├── sections/
└── attachments/         ← reference PDFs the agent should review
```

## Notes

- The context block is **token-bounded** (a few hundred tokens) so it stays cheap
  for small local Ollama models, and is **cached** per project (it refreshes when
  you add/remove context files or skills, or edit the inlined master file).
- Works the same whether you open a folder or an extracted project — it reads the
  files in the project directory.
- `.git/`, `.venv/`, `.prism/`, `.claudeprism/`, `.claude/`, `node_modules/`, and
  build artifacts are hidden from the map automatically.
