---
name: resume-cv
description: "Use when the user wants to write, build, or tailor a resume / CV and matching cover letter, especially an ATS-friendly LaTeX resume tuned to a job description. Examples: \"help me write a resume\", \"build my CV in LaTeX\", \"tailor my resume to this job description\", \"make an ATS-friendly resume\", \"write a cover letter for this posting\", \"fix my resume bullets\", \"compile my resume to PDF\"."
---

# Resume / CV Authoring (ATS-friendly LaTeX)

Help the user produce a clean, single-column, ATS-friendly LaTeX resume and a matching
one-page cover letter, then tailor both to a specific job description. Everything compiles
locally with `tectonic` (no internet, no cloud LaTeX). Templates use only common TeX Live
packages: `geometry`, `enumitem`, `titlesec`, `hyperref`, `xcolor`, `fontawesome5` (optional).

## When to Use

Trigger this skill when the user says things like:

- "Help me write a resume" / "build my CV in LaTeX"
- "Make my resume ATS-friendly" / "will this pass ATS scanning?"
- "Tailor my resume to this job description" (then they paste a JD)
- "Rewrite my experience bullets to quantify impact"
- "Write a cover letter for this posting"
- "Compile my resume to a PDF" / "the resume won't build"

Do NOT use this for academic publications, grant proposals, or long-form CVs with
publication lists unless the user specifically wants the lightweight resume style here.

## Workflow

Follow these steps in order. Keep questions short and batched so a small local model
stays focused.

1. **Decide resume vs. CV.** Ask one question: "1-page job resume (most roles), or longer
   academic CV?" This skill is optimized for the 1-page resume. If they want a multi-page
   academic CV, still use `templates/resume.tex` but allow Experience/Projects to flow onto
   page 2 and add a Publications section.

2. **Collect raw material.** Ask the user for, in one message:
   - Full name, city/region, email, phone, and (optional) GitHub/LinkedIn/portfolio URLs.
   - Each job: company, title, location, start/end dates, and 2-5 rough bullet points of
     what they did (no need to polish yet).
   - Education: school, degree, graduation year, optional GPA/honors.
   - Projects (optional): name, one-line description, tech used, link.
   - A flat list of skills/tools.
   If the user pastes an existing resume, parse it into these buckets instead of asking again.

3. **Get the target job description (if tailoring).** Ask the user to paste the JD. If they
   have no specific job, skip tailoring and write strong general bullets.

4. **Extract keywords from the JD.** Read the pasted JD and list the concrete, ATS-relevant
   keywords: hard skills (languages, frameworks, tools), domain terms, and required
   qualifications. Prefer the exact phrasing the JD uses (e.g. if the JD says "CI/CD
   pipelines", use that exact phrase, not "build automation"). Show the user this keyword
   list so they can confirm honesty (never claim a skill the user does not have).

5. **Rewrite each experience bullet.** For every bullet, apply this pattern:
   `Strong verb + what you did + tools/method + quantified impact`.
   - Start with a past-tense action verb (Built, Led, Reduced, Automated, Designed, Shipped).
   - Mirror JD keywords naturally where they are truthful.
   - Quantify: %, count, time saved, money, scale, users. If the user has no exact number,
     ask for a rough estimate ("about how many users / how much faster?") rather than
     inventing one.
   - One line per bullet, ideally under ~2 lines when rendered. 3-5 bullets per recent role.
   Example transform:
   - Before: "Worked on the payments system and fixed bugs."
   - After: "Reduced payment failures 18% by rewriting the retry layer in Go and adding
     idempotency keys across 4 services."

6. **Choose sections and order.** Default order: Header, Summary (optional, 2 lines),
   Skills, Experience, Projects, Education. For new grads, move Education above Experience
   and emphasize Projects. Drop the Summary if space is tight. Cut anything that does not
   help the target role.

7. **Fill the template.** Edit a copy of `templates/resume.tex`, replacing every `<...>`
   placeholder. Keep it to ONE page (see Tips). Do not add tables, columns, text boxes,
   images, or icons-as-text that ATS parsers choke on.

8. **Write the cover letter (if requested).** Edit `templates/cover-letter.tex`. Keep it to
   one page, 3-4 short paragraphs: (a) the role + a hook, (b) 1-2 proof points matching the
   JD's top needs, (c) why this company specifically, (d) a brief close + call to action.

9. **Compile locally with tectonic.** From the skill/project folder run:
   ```
   tectonic resume.tex
   tectonic cover-letter.tex
   ```
   This produces `resume.pdf` / `cover-letter.pdf` with no internet access. If `tectonic`
   is unavailable, fall back to `pdflatex resume.tex` (run twice so `hyperref`/`titlesec`
   refs settle). Report any LaTeX errors to the user and fix the offending line.

10. **Final ATS + length review.** Confirm: one page, single column, no graphics/tables,
    standard section headings, real text (selectable, not an image), keywords present and
    truthful. Offer to export plain text if an application portal wants a `.txt`.

## Templates

- **`templates/resume.tex`** — The main resume. Clean single-column, ATS-friendly layout
  with sections for header (name + contact line), summary, skills, experience (with bullet
  points via `enumitem`), projects, and education. Uses `geometry` for margins, `titlesec`
  for section rules, `enumitem` for tight bullets, and `hyperref` for clickable (but
  plain-text-parseable) links. Use this for every resume. All content is in `<ANGLE>`
  placeholders — replace them and delete unused sections.

- **`templates/cover-letter.tex`** — A professional one-page cover letter. Has a sender
  block, date, recipient block, salutation, body paragraphs, and signature, all as
  placeholders. Same lightweight packages. Use when the user wants a cover letter to
  accompany the resume.

Both templates compile standalone with `tectonic <file>.tex`.

## Tips & Conventions

- **Keep it to 1 page.** Levers, in order: trim older/irrelevant roles to 1-2 bullets,
  drop the Summary, tighten wording, reduce `\geometry` margins slightly (the template
  exposes a margin variable), or shrink line spacing. Do NOT go below 10pt font or
  margins under ~0.5in — recruiters and ATS both dislike cramped pages.
- **ATS pitfalls to avoid:** no multi-column layouts, no tables for layout, no images,
  logos, charts, or text inside graphics, no headers/footers for critical info (some
  parsers skip them), no fancy unicode glyphs as bullets, and no putting your name only
  in a graphic. The provided template already avoids all of these.
- **Use standard section headings** ("Experience", "Education", "Skills", "Projects") so
  parsers map them correctly. Avoid cute names like "Where I've Made Magic".
- **Dates:** use a consistent format, e.g. `Jan 2022 -- Present`. The template uses an
  em dash range; keep it consistent across entries.
- **Verbs & tense:** past tense for past roles, present tense for the current role. Lead
  every bullet with a verb; never start with "Responsible for".
- **Truthfulness:** mirror JD keywords only where the user genuinely has the skill.
  Inflating skills fails technical screens and is the one thing this skill must not do.
- **One source of truth:** keep a master resume with all roles/bullets, then create a
  trimmed, JD-tailored copy per application rather than editing the master.
- **Links:** the template wraps URLs in `\href{}{}` so they are clickable yet still appear
  as readable text for ATS. Always show the human-readable URL, not "click here".

## Offline / Local-LLM Notes

- Everything here is fully offline. `tectonic` fetches packages from a local cache after the
  first run; on a machine that has compiled LaTeX before, no network is needed.
- For a small local model (llama3 / qwen via Ollama): work one section at a time and keep
  the JD plus only the relevant role in context, rather than the whole resume at once. Do:
  "rewrite these 3 bullets using these 6 keywords" — short, explicit, bounded.
- When extracting JD keywords, ask the model to output a plain bullet list of nouns/skills
  only — no prose — so a small model stays reliable.
- Do not depend on any web lookup of "ATS rules" or job-board APIs; all guidance needed is
  in this file. If the user asks about a specific portal, give the general plain-text /
  single-column advice above rather than guessing portal-specific behavior.
- If compilation fails, read the first `! ` error line in tectonic's output, map it to the
  offending `.tex` line, fix that one line, and recompile — don't regenerate the whole file.
