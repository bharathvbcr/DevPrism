# Onboarding flow — status and blockers

*July 2026. Documents the project-creation onboarding surface in DevPrism.*

## Current flow (after incremental consolidation)

1. **Project picker** (`project-picker.tsx`) — home screen with spaces, recent projects, and settings.
2. **Create New Project** opens the full-page **ProjectWizard** in `"choose"` mode (template vs blank). The former stacked mode-selection dialog was removed.
3. **Guided Setup** → template gallery + `TemplatePreview` modal for details.
4. **Blank Document** → inline scratch form in `project-wizard.tsx`.
5. **First launch** may still show `EnvironmentOnboarding` (`App.tsx`) for Python/uv/skills — separate from project creation.

## What was improved

- Mode selection is now the first wizard step instead of a modal stacked on the picker.
- Space context hint travels with the wizard chooser (`NewProjectSpaceHint` in `project-wizard.tsx`).

## Remaining blockers (full single-flow wizard)

| Blocker | Why it blocks a bigger refactor |
|--------|----------------------------------|
| `project-picker.tsx` size (~3,600 lines) | Hosts settings, spaces, previews, drag-drop import, and 4+ dialogs (space edit/delete, remove project, etc.). Extracting onboarding without splitting the file risks regressions. |
| `TemplatePreview` modal | Template path still uses a nested modal inside the gallery wizard — a true single-page flow needs wizard step state shared between gallery, preview PDF, and project details. |
| `EnvironmentOnboarding` + `ClaudeSetup` | Global setup gates live outside the picker; merging them requires coordinated routing in `App.tsx` and deferred/non-blocking setup policy. |
| Scientific skills onboarding | Lazy-loaded from sidebar and picker (`scientific-skills-onboarding.tsx`) — third parallel onboarding surface. |

## Recommended next steps (low risk)

1. Extract `ProjectCreationWizard` from `project-picker.tsx` (chooser + wizard only).
2. Promote `TemplatePreview` from modal to wizard step 2 for the template path.
3. Add a “Skip for now” path on `EnvironmentOnboarding` that does not block project open.
4. Unify space create/edit into a slide-over panel instead of a centered dialog.

## Out of scope for this pass

- Merging Claude/uv/Ollama setup into project creation.
- Removing space or remove-project confirmation dialogs (they are intentional safety gates).
