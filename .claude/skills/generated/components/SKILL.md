---
name: components
description: "Skill for the Components area of DevPrism. 205 symbols across 47 files."
---

# Components

205 symbols | 47 files | Cohesion: 65%

## When to Use

- Working with code in `apps/`
- Understanding how ChatMessages, ChatStarterChips, NativeOllamaEmptyState work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/project-picker.tsx` | isProjectDrag, ProjectPicker, setWizardActive, checkClaudeStatus, setActiveSpace (+34) |
| `apps/desktop/src/components/claude-setup.tsx` | useInstallEvents, useLoginEvents, StepRow, InstallLogOutput, ClaudeSetup (+15) |
| `apps/desktop/src/components/settings-dialog.tsx` | SettingsDialog, setNativeNumCtx, setNativeTemperature, setNativeKeepAlive, setNativeOllamaModel (+12) |
| `apps/desktop/src/components/command-palette.tsx` | matchesQuery, CommandPalette, close, runAction, lexicalMatches (+9) |
| `apps/desktop/src/components/environment-onboarding.tsx` | EnvironmentOnboarding, completeOnboarding, hydrateSetupFlow, checkClaudeStatus, checkUvStatus (+8) |
| `apps/desktop/src/components/project-wizard.tsx` | WizardOnboardingStep, ProjectWizard, ScratchForm, handleRemoveAttachment, addRecentProject (+6) |
| `apps/desktop/src/lib/ollama.ts` | listOllamaModels, getOllamaStatus, isOllamaEndpoint, resolveOllamaCredential, getOllamaBaseUrl (+3) |
| `apps/desktop/src/lib/platform-dialog.ts` | pickProjectFolder, pickProjectFiles, pickBrowserProjectFiles, buildAcceptAttribute, saveProjectFile (+1) |
| `apps/desktop/src/components/claude-chat/chat-messages.tsx` | StreamingIndicator, calculateElapsed, timer, ContextTruncationNotice, ChatMessages |
| `apps/desktop/src/components/wizard-setup-checklist.tsx` | SetupChip, WizardSetupChecklist, checkClaude, checkUv, checkSkills |

## Entry Points

Start here when exploring this area:

- **`ChatMessages`** (Function) — `apps/desktop/src/components/claude-chat/chat-messages.tsx:342`
- **`ChatStarterChips`** (Function) — `apps/desktop/src/components/claude-chat/chat-starter-chips.tsx:2`
- **`NativeOllamaEmptyState`** (Function) — `apps/desktop/src/components/claude-chat/native-ollama-empty-state.tsx:24`
- **`ClaudeSetup`** (Function) — `apps/desktop/src/components/claude-setup.tsx:509`
- **`fetchProviderModels`** (Function) — `apps/desktop/src/components/claude-setup.tsx:550`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ChatMessages` | Function | `apps/desktop/src/components/claude-chat/chat-messages.tsx` | 342 |
| `ChatStarterChips` | Function | `apps/desktop/src/components/claude-chat/chat-starter-chips.tsx` | 2 |
| `NativeOllamaEmptyState` | Function | `apps/desktop/src/components/claude-chat/native-ollama-empty-state.tsx` | 24 |
| `ClaudeSetup` | Function | `apps/desktop/src/components/claude-setup.tsx` | 509 |
| `fetchProviderModels` | Function | `apps/desktop/src/components/claude-setup.tsx` | 550 |
| `setupSurfaceClass` | Function | `apps/desktop/src/components/claude-setup.tsx` | 559 |
| `resetProviderForm` | Function | `apps/desktop/src/components/claude-setup.tsx` | 604 |
| `handleFetchModels` | Function | `apps/desktop/src/components/claude-setup.tsx` | 655 |
| `EnvironmentOnboarding` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 48 |
| `completeOnboarding` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 58 |
| `hydrateSetupFlow` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 59 |
| `checkClaudeStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 77 |
| `checkUvStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 84 |
| `checkSkillsStatus` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 89 |
| `handleDone` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 215 |
| `SettingsAiFeatures` | Function | `apps/desktop/src/components/settings-ai-features.tsx` | 30 |
| `SettingsCollapsibleSection` | Function | `apps/desktop/src/components/settings-collapsible-section.tsx` | 4 |
| `SettingsDialog` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 127 |
| `setNativeNumCtx` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 137 |
| `setNativeTemperature` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 139 |

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
| Workspace | 46 calls |
| Ui | 28 calls |
| Browser-project | 13 calls |
| Semantic-layer | 6 calls |
| Claude-chat | 4 calls |
| Hooks | 4 calls |
| Cluster_334 | 3 calls |
| Template-gallery | 3 calls |

## How to Explore

1. `context({name: "ChatMessages"})` — see callers and callees
2. `query({search_query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
