---
name: statement-authoring
description: "Use when the user wants to write, revise, or tailor a personal statement, statement of purpose (SOP), motivation letter, or graduate-school essay in LaTeX. Examples: \"help me write my SOP\", \"tailor this personal statement to a program prompt\", \"tighten my statement to 750 words\", \"make the opening stronger\", \"adapt this essay for a different prompt\", \"compile my statement to PDF\"."
---

# Personal Statement / SOP Authoring

Help the user write a compelling, truthful personal statement or statement of
purpose (SOP) in LaTeX — tailored to a specific program prompt when one is
provided. Everything compiles locally with `tectonic` (no internet required).
Use `templates/statement.tex` as the starting scaffold.

## When to Use

Trigger this skill when the user says things like:

- "Help me write my personal statement" / "draft my SOP"
- "Tailor this statement to this program's prompt" (they paste the prompt)
- "Tighten my essay to fit the word limit"
- "Strengthen the opening" / "make it less generic"
- "Revise for clarity and flow without changing the facts"
- "Compile my statement to PDF"

Do **not** use this for job resumes (use `resume-cv`) or research manuscripts
(use `manuscript-paper`). Cover letters for job postings belong in `resume-cv`.

## Workflow

Follow these steps in order. Keep questions batched so a small local model stays
focused.

1. **Confirm the deliverable.** Ask once: personal statement, SOP, motivation
   letter, or diversity statement? Note any word/character limit from
   `JOB_DESCRIPTION.md` or the pasted prompt.

2. **Collect source material.** From `MASTER.md`, `PROFILE.md`, or the user's
   chat, gather: academic/professional path, 2–3 defining experiences, research
   or career goals, and why this specific program. Never invent credentials.

3. **Read the target prompt.** If `JOB_DESCRIPTION.md` exists (or the user
   pastes a prompt), extract: the exact question(s), themes the committee cares
   about, word limit, and any formatting rules.

4. **Outline before prose.** Propose a short outline (3–5 beats) mapped to the
   prompt's themes. Get a quick yes/no before drafting long paragraphs.

5. **Draft in the user's voice.** Use `templates/statement.tex`:
   - Replace `<NAME>`, `<PROGRAM>`, and section placeholders.
   - One clear narrative thread; each paragraph advances a single idea.
   - Prefer concrete scenes and outcomes over abstract claims.
   - Mirror prompt language where truthful.

6. **Enforce limits.** If a word cap exists, count prose words (ignore LaTeX
   commands) and trim repetition before adding new content.

7. **Tailor an existing draft.** When revising for a new prompt:
   - Keep facts and voice; change emphasis and examples to match the new question.
   - List what changed at the end.

8. **Compile.** From the project folder:
   ```
   tectonic main.tex
   ```
   or the file name the user uses (`statement.tex`, etc.).

## Tips

- **Opening paragraph:** Hook with a specific moment, not a cliché ("ever since
  childhood").
- **Program fit:** Tie the user's background to this program's faculty, labs, or
  curriculum — not generic praise.
- **Tone:** Confident and reflective; avoid resume-style bullet dumps unless the
  prompt asks for a CV-style list.
- **Length levers:** Tighten transitions, merge overlapping paragraphs, cut
  duplicate examples before cutting unique substance.

## Templates

| File | Purpose |
|------|---------|
| `templates/statement.tex` | Single-file statement scaffold with readable margins |

Copy `templates/statement.tex` to `main.tex` or `statement.tex` in the project
root and fill placeholders.
