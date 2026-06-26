---
name: tauri
description: "Skill for the Tauri area of DevPrism. 14 symbols across 6 files."
---

# Tauri

14 symbols | 6 files | Cohesion: 76%

## When to Use

- Working with code in `apps/`
- Understanding how shouldSkipProjectDirectory, getProjectFileType, scanProjectFolder work
- Modifying tauri-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/tauri/fs.ts` | shouldSkipProjectDirectory, getProjectFileType, scanProjectFolder, walk, getAssetUrl |
| `apps/desktop/src/components/project-picker.tsx` | firstExistingProjectFile, firstExistingPath, findMainTexFile, handleInstallSpaceSkills |
| `apps/desktop/src/lib/tauri/skills.ts` | installBundledSkills, listInstalledSkills |
| `apps/desktop/src/lib/space-project.ts` | installMissingSkillsForKind |
| `apps/desktop/src/lib/space-features.ts` | bundledSkillsForKind |
| `apps/desktop/src/components/workspace/editor/image-preview.tsx` | ImagePreview |

## Entry Points

Start here when exploring this area:

- **`shouldSkipProjectDirectory`** (Function) — `apps/desktop/src/lib/tauri/fs.ts:98`
- **`getProjectFileType`** (Function) — `apps/desktop/src/lib/tauri/fs.ts:104`
- **`scanProjectFolder`** (Function) — `apps/desktop/src/lib/tauri/fs.ts:128`
- **`walk`** (Function) — `apps/desktop/src/lib/tauri/fs.ts:132`
- **`bundledSkillsForKind`** (Function) — `apps/desktop/src/lib/space-features.ts:552`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `shouldSkipProjectDirectory` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 98 |
| `getProjectFileType` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 104 |
| `scanProjectFolder` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 128 |
| `walk` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 132 |
| `bundledSkillsForKind` | Function | `apps/desktop/src/lib/space-features.ts` | 552 |
| `handleInstallSpaceSkills` | Function | `apps/desktop/src/components/project-picker.tsx` | 750 |
| `installBundledSkills` | Function | `apps/desktop/src/lib/tauri/skills.ts` | 11 |
| `listInstalledSkills` | Function | `apps/desktop/src/lib/tauri/skills.ts` | 21 |
| `getAssetUrl` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 212 |
| `ImagePreview` | Function | `apps/desktop/src/components/workspace/editor/image-preview.tsx` | 41 |
| `firstExistingProjectFile` | Function | `apps/desktop/src/components/project-picker.tsx` | 2326 |
| `firstExistingPath` | Function | `apps/desktop/src/components/project-picker.tsx` | 2342 |
| `findMainTexFile` | Function | `apps/desktop/src/components/project-picker.tsx` | 2360 |
| `installMissingSkillsForKind` | Function | `apps/desktop/src/lib/space-project.ts` | 71 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ProjectPreviewCard → Has` | cross_community | 7 |
| `ProjectPreviewCard → GetProjectFileType` | cross_community | 6 |
| `LoadProjectPreview → Has` | cross_community | 6 |
| `LoadProjectPreview → GetProjectFileType` | cross_community | 5 |
| `ProjectPreviewCard → FirstExistingProjectFile` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Editor | 2 calls |
| Cluster_156 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "shouldSkipProjectDirectory"})` — see callers and callees
2. `gitnexus_query({query: "tauri"})` — find related execution flows
3. Read key files listed above for implementation details
