---
name: components
description: "Skill for the Components area of DevPrism. 213 symbols across 49 files."
---

# Components

213 symbols | 49 files | Cohesion: 64%

## When to Use

- Working with code in `apps/`
- Understanding how ClaudeSetup, fetchProviderModels, setupSurfaceClass work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/project-picker.tsx` | isProjectDrag, ProjectPicker, setWizardActive, checkClaudeStatus, setActiveSpace (+34) |
| `apps/desktop/src/components/claude-setup.tsx` | useInstallEvents, useLoginEvents, StepRow, InstallLogOutput, ClaudeSetup (+19) |
| `apps/desktop/src/components/settings-dialog.tsx` | SettingsDialog, setAgentBackend, setNativeGroqModel, setNativeNumCtx, setNativeTemperature (+13) |
| `apps/desktop/src/components/command-palette.tsx` | matchesQuery, CommandPalette, close, runAction, lexicalMatches (+9) |
| `apps/desktop/src/components/environment-onboarding.tsx` | EnvironmentOnboarding, completeOnboarding, hydrateSetupFlow, checkClaudeStatus, checkUvStatus (+8) |
| `apps/desktop/src/components/project-wizard.tsx` | WizardOnboardingStep, ProjectWizard, ScratchForm, handleRemoveAttachment, addRecentProject (+5) |
| `apps/desktop/src/components/cursor-setup.tsx` | StepRow, InstallLogOutput, CursorSetup, checkStatus, install (+4) |
| `apps/desktop/src/components/groq-setup.tsx` | StepRow, InstallLogOutput, GroqSetup, checkStatus, install (+3) |
| `apps/desktop/src/components/wizard-setup-checklist.tsx` | SetupChip, WizardSetupChecklist, checkClaude, checkUv, checkSkills |
| `apps/desktop/src/lib/project-delete.ts` | deleteProjectDialogCopy, normalizeProjectPath, isSameProjectPath, deleteProjectFromApp |

## Entry Points

Start here when exploring this area:

- **`ClaudeSetup`** (Function) — `apps/desktop/src/components/claude-setup.tsx:536`
- **`fetchProviderModels`** (Function) — `apps/desktop/src/components/claude-setup.tsx:577`
- **`setupSurfaceClass`** (Function) — `apps/desktop/src/components/claude-setup.tsx:586`
- **`resetProviderForm`** (Function) — `apps/desktop/src/components/claude-setup.tsx:631`
- **`handleFetchModels`** (Function) — `apps/desktop/src/components/claude-setup.tsx:682`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ClaudeSetup` | Function | `apps/desktop/src/components/claude-setup.tsx` | 536 |
| `fetchProviderModels` | Function | `apps/desktop/src/components/claude-setup.tsx` | 577 |
| `setupSurfaceClass` | Function | `apps/desktop/src/components/claude-setup.tsx` | 586 |
| `resetProviderForm` | Function | `apps/desktop/src/components/claude-setup.tsx` | 631 |
| `handleFetchModels` | Function | `apps/desktop/src/components/claude-setup.tsx` | 682 |
| `EnvironmentOnboarding` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 72 |
| `completeOnboarding` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 82 |
| `hydrateSetupFlow` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 83 |
| `checkClaudeStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 101 |
| `checkUvStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 108 |
| `checkSkillsStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 114 |
| `handleDone` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 240 |
| `SettingsAiFeatures` | Function | `apps/desktop/src/components/settings-ai-features.tsx` | 30 |
| `SettingsCollapsibleSection` | Function | `apps/desktop/src/components/settings-collapsible-section.tsx` | 4 |
| `SettingsDialog` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 139 |
| `setAgentBackend` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 144 |
| `setNativeGroqModel` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 146 |
| `setNativeNumCtx` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 154 |
| `setNativeTemperature` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 156 |
| `setNativeKeepAlive` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 158 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleCreate → OpfsProjectsRoot` | cross_community | 9 |
| `HandleCreate → GetFsaDirectoryAtRelativePath` | cross_community | 7 |
| `RenderApiKeyForm → DeepseekOrigin` | cross_community | 7 |
| `RenderApiKeyForm → QwenOrigin` | cross_community | 7 |
| `RenderApiKeyForm → NormalizeOriginOnlyUrl` | cross_community | 7 |
| `RenderApiKeyForm → MoonshotOrigin` | cross_community | 7 |
| `ImportDroppedBrowserFiles → OpfsProjectsRoot` | cross_community | 7 |
| `HandleCreate → ParseBrowserRoot` | cross_community | 6 |
| `HandleCreate → BrowserRootPath` | cross_community | 6 |
| `HandleCreate → RelativeFromBrowserAbsolute` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Career | 44 calls |
| Ui | 33 calls |
| Browser-project | 15 calls |
| Stores | 6 calls |
| Template-gallery | 5 calls |
| Claude-chat | 5 calls |
| Semantic-layer | 4 calls |
| Workspace | 4 calls |

## How to Explore

1. `context({name: "ClaudeSetup"})` — see callers and callees
2. `query({search_query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
