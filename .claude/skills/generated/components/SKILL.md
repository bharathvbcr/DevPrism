---
name: components
description: "Skill for the Components area of devprism-main. 16 symbols across 7 files."
---

# Components

16 symbols | 7 files | Cohesion: 97%

## When to Use

- Working with code in `apps/`
- Understanding how SettingsDialog, handleProviderChange, handleRemoveAuthorizedPath work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/settings-dialog.tsx` | manualSkillsOnly, SettingsDialog, handleProviderChange, handleRemoveAuthorizedPath, saveSkill (+1) |
| `apps/desktop/src/components/project-picker.tsx` | ProjectPicker, handleOpenRecent, handleSelectMode |
| `apps/desktop/src/components/dev-engine-setup.tsx` | useInstallEvents, useLoginEvents, DevEngineSetup |
| `apps/desktop/src/hooks/use-updater.ts` | useUpdater |
| `apps/desktop/src/lib/template-registry.ts` | getTemplateSkeleton |
| `apps/desktop/src/components/project-wizard.tsx` | handleCreate |
| `apps/desktop/src/components/template-gallery/template-preview.tsx` | handleCreate |

## Entry Points

Start here when exploring this area:

- **`SettingsDialog`** (Function) — `apps/desktop/src/components/settings-dialog.tsx:114`
- **`handleProviderChange`** (Function) — `apps/desktop/src/components/settings-dialog.tsx:217`
- **`handleRemoveAuthorizedPath`** (Function) — `apps/desktop/src/components/settings-dialog.tsx:359`
- **`saveSkill`** (Function) — `apps/desktop/src/components/settings-dialog.tsx:364`
- **`deleteSkill`** (Function) — `apps/desktop/src/components/settings-dialog.tsx:383`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `SettingsDialog` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 114 |
| `handleProviderChange` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 217 |
| `handleRemoveAuthorizedPath` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 359 |
| `saveSkill` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 364 |
| `deleteSkill` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 383 |
| `useUpdater` | Function | `apps/desktop/src/hooks/use-updater.ts` | 14 |
| `ProjectPicker` | Function | `apps/desktop/src/components/project-picker.tsx` | 37 |
| `handleOpenRecent` | Function | `apps/desktop/src/components/project-picker.tsx` | 69 |
| `handleSelectMode` | Function | `apps/desktop/src/components/project-picker.tsx` | 74 |
| `getTemplateSkeleton` | Function | `apps/desktop/src/lib/template-registry.ts` | 3265 |
| `handleCreate` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 405 |
| `DevEngineSetup` | Function | `apps/desktop/src/components/dev-engine-setup.tsx` | 239 |
| `manualSkillsOnly` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 66 |
| `handleCreate` | Function | `apps/desktop/src/components/project-wizard.tsx` | 237 |
| `useInstallEvents` | Function | `apps/desktop/src/components/dev-engine-setup.tsx` | 24 |
| `useLoginEvents` | Function | `apps/desktop/src/components/dev-engine-setup.tsx` | 98 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SettingsDialog → ManualSkillsOnly` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Ui | 1 calls |

## How to Explore

1. `gitnexus_context({name: "SettingsDialog"})` — see callers and callees
2. `gitnexus_query({query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
