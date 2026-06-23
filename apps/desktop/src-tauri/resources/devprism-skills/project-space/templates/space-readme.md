# {{SPACE_NAME}}

> DevPrism Project Space — offline-first scientific writing workspace.

## Purpose

{{SPACE_PURPOSE}}

<!-- One or two sentences: what ties these projects together (a research topic,
     a deliverable type like resumes, a collaborator, or a venue). -->

## Projects

| Project | Type | Description |
| ------- | ---- | ----------- |
| {{PROJECT_1_NAME}} | {{PROJECT_1_TYPE}} | {{PROJECT_1_DESCRIPTION}} |
| {{PROJECT_2_NAME}} | {{PROJECT_2_TYPE}} | {{PROJECT_2_DESCRIPTION}} |
| {{PROJECT_3_NAME}} | {{PROJECT_3_TYPE}} | {{PROJECT_3_DESCRIPTION}} |

<!-- Type is the deliverable, e.g. paper, slides, thesis, resume, cover-letter. -->

## Shared Conventions

- **Bibliography:** {{SHARED_BIB_PATH}} (e.g. `./references.bib`) — all projects
  cite from this single source of truth.
- **Naming scheme:** {{NAMING_SCHEME}} (e.g. `{{SPACE_NAME}}-<deliverable>-<short-name>`).
- **Shared assets:** {{ASSETS_PATH}} (e.g. `./assets/` for logos, `.cls`/`.sty`,
  and reused figures).
- **Cross-references:** when a project reuses content from a sibling, link back
  to the source project instead of copy-pasting.

## Defaults

- **Provider:** `ollama` (fully offline / local LLM)
- **Default model:** `{{DEFAULT_MODEL}}` <!-- e.g. llama3.1:8b; empty = app default -->
- **Attached skills:** {{SKILL_IDS}} <!-- e.g. manuscript-paper, latex-toolkit, beamer-slides -->

## Notes

{{NOTES}}

<!-- Anything space-specific: deadlines, target venues, collaborators,
     model-pull reminders (ollama pull <model>), or build quirks. -->
