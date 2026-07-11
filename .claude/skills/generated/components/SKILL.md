---
name: components
description: "Skill for the Components area of DevPrism. 221 symbols across 50 files."
---

# Components

221 symbols | 50 files | Cohesion: 65%

## When to Use

- Working with code in `apps/`
- Understanding how ClaudeSetup, fetchProviderModels, setupSurfaceClass work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/project-picker.tsx` | isProjectDrag, ProjectPicker, setWizardActive, checkClaudeStatus, setActiveSpace (+35) |
| `apps/desktop/src/components/claude-setup.tsx` | useInstallEvents, useLoginEvents, StepRow, InstallLogOutput, ClaudeSetup (+15) |
| `apps/desktop/src/components/settings-dialog.tsx` | SettingsDialog, setAgentBackend, setNativeGroqModel, setNativeNumCtx, setNativeTemperature (+13) |
| `apps/desktop/src/components/environment-onboarding.tsx` | EnvironmentOnboarding, completeOnboarding, hydrateSetupFlow, checkClaudeStatus, checkUvStatus (+9) |
| `apps/desktop/src/components/command-palette.tsx` | matchesQuery, CommandPalette, close, runAction, lexicalMatches (+9) |
| `apps/desktop/src/components/project-wizard.tsx` | WizardOnboardingStep, ProjectWizard, ScratchForm, handleRemoveAttachment, addRecentProject (+6) |
| `apps/desktop/src/components/cursor-setup.tsx` | StepRow, InstallLogOutput, CursorSetup, checkStatus, install (+4) |
| `apps/desktop/src/components/groq-setup.tsx` | StepRow, InstallLogOutput, GroqSetup, checkStatus, install (+3) |
| `apps/desktop/src/lib/platform-dialog.ts` | pickProjectFolder, pickProjectFiles, pickBrowserProjectFiles, buildAcceptAttribute, saveProjectFile (+1) |
| `apps/desktop/src/components/wizard-setup-checklist.tsx` | SetupChip, WizardSetupChecklist, checkClaude, checkUv, checkSkills |

## Entry Points

Start here when exploring this area:

- **`ClaudeSetup`** (Function) — `apps/desktop/src/components/claude-setup.tsx:517`
- **`fetchProviderModels`** (Function) — `apps/desktop/src/components/claude-setup.tsx:558`
- **`setupSurfaceClass`** (Function) — `apps/desktop/src/components/claude-setup.tsx:567`
- **`resetProviderForm`** (Function) — `apps/desktop/src/components/claude-setup.tsx:612`
- **`handleFetchModels`** (Function) — `apps/desktop/src/components/claude-setup.tsx:663`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ClaudeSetup` | Function | `apps/desktop/src/components/claude-setup.tsx` | 517 |
| `fetchProviderModels` | Function | `apps/desktop/src/components/claude-setup.tsx` | 558 |
| `setupSurfaceClass` | Function | `apps/desktop/src/components/claude-setup.tsx` | 567 |
| `resetProviderForm` | Function | `apps/desktop/src/components/claude-setup.tsx` | 612 |
| `handleFetchModels` | Function | `apps/desktop/src/components/claude-setup.tsx` | 663 |
| `EnvironmentOnboarding` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 68 |
| `completeOnboarding` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 78 |
| `hydrateSetupFlow` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 79 |
| `checkClaudeStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 97 |
| `checkUvStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 104 |
| `checkSkillsStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 110 |
| `handleDone` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 236 |
| `SettingsAiFeatures` | Function | `apps/desktop/src/components/settings-ai-features.tsx` | 30 |
| `SettingsCollapsibleSection` | Function | `apps/desktop/src/components/settings-collapsible-section.tsx` | 4 |
| `SettingsDialog` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 137 |
| `setAgentBackend` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 142 |
| `setNativeGroqModel` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 144 |
| `setNativeNumCtx` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 150 |
| `setNativeTemperature` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 152 |
| `setNativeKeepAlive` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 154 |

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
| Workspace | 47 calls |
| Ui | 34 calls |
| Browser-project | 16 calls |
| Semantic-layer | 6 calls |
| Cluster_342 | 3 calls |
| Hooks | 3 calls |
| Template-gallery | 3 calls |
| Cluster_362 | 3 calls |

## How to Explore

1. `context({name: "ClaudeSetup"})` — see callers and callees
2. `query({search_query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
