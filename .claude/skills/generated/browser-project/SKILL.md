---
name: browser-project
description: "Skill for the Browser-project area of DevPrism. 118 symbols across 19 files."
---

# Browser-project

118 symbols | 19 files | Cohesion: 80%

## When to Use

- Working with code in `apps/`
- Understanding how refreshFiles, handleCreateBib, getStagedBrowserFile work
- Modifying browser-project-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/browser-project/opfs-store.ts` | getOpfsDirectoryAtRelativePath, writeOpfsFile, readOpfsFile, opfsFileExists, removeOpfsEntry (+13) |
| `apps/desktop/src/lib/browser-project/browser-fs.ts` | splitBrowserAbsolutePath, walkBrowserProject, scanBrowserProjectFolder, readBrowserTextFile, readBrowserFile (+8) |
| `apps/desktop/src/lib/tauri/fs.ts` | scanProjectFolder, walk, readImageAsDataUrl, createFileOnDisk, getUniqueTargetName (+8) |
| `apps/desktop/src/lib/browser-project/fsa-store.ts` | directoryEntries, entries, getFsaDirectoryAtRelativePath, writeFsaFile, readFsaFile (+7) |
| `apps/desktop/src/stores/document-store.ts` | migratePdfBytesKey, migrateCacheKey, deleteFolder, renameFile, createNewFile (+5) |
| `apps/desktop/src/lib/browser-project/constants.ts` | isBrowserProjectPath, browserJoin, parseBrowserRoot, relativeFromBrowserAbsolute, sanitizeProjectName (+4) |
| `apps/desktop/src/lib/browser-project/fsa-persistence.ts` | openDb, persistFsaRoot, removePersistedFsaRoot, getPersistedFsaFolderName, loadPersistedFsaRoot (+2) |
| `apps/desktop/src/components/project-picker.tsx` | firstExistingProjectFile, firstExistingPath, findMainTexFile, onDragEnter, onDragOver (+1) |
| `apps/desktop/src/lib/browser-project/drag-drop.ts` | readDirectoryEntry, readBatch, entryToDropFiles, collectBrowserDropFiles, hasBrowserFileDrag |
| `apps/desktop/src/lib/browser-project/attachment-staging.ts` | getStagedBrowserFile, stageBrowserFile, isStagedBrowserFilePath, stagedBrowserFileName |

## Entry Points

Start here when exploring this area:

- **`refreshFiles`** (Function) — `apps/desktop/src/components/workspace/bibliography-panel.tsx:81`
- **`handleCreateBib`** (Function) — `apps/desktop/src/components/workspace/bibliography-panel.tsx:178`
- **`getStagedBrowserFile`** (Function) — `apps/desktop/src/lib/browser-project/attachment-staging.ts:20`
- **`scanBrowserProjectFolder`** (Function) — `apps/desktop/src/lib/browser-project/browser-fs.ts:63`
- **`readBrowserTextFile`** (Function) — `apps/desktop/src/lib/browser-project/browser-fs.ts:99`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `refreshFiles` | Function | `apps/desktop/src/components/workspace/bibliography-panel.tsx` | 81 |
| `handleCreateBib` | Function | `apps/desktop/src/components/workspace/bibliography-panel.tsx` | 178 |
| `getStagedBrowserFile` | Function | `apps/desktop/src/lib/browser-project/attachment-staging.ts` | 20 |
| `scanBrowserProjectFolder` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 63 |
| `readBrowserTextFile` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 99 |
| `readBrowserFile` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 113 |
| `writeBrowserFile` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 125 |
| `browserPathExists` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 139 |
| `mkdirBrowserPath` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 155 |
| `statBrowserFile` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 166 |
| `removeBrowserPath` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 178 |
| `readBrowserImageAsDataUrl` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 192 |
| `getBrowserAssetUrlAsync` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 214 |
| `getUniqueBrowserTargetName` | Function | `apps/desktop/src/lib/browser-project/browser-fs.ts` | 236 |
| `isBrowserProjectPath` | Function | `apps/desktop/src/lib/browser-project/constants.ts` | 27 |
| `browserJoin` | Function | `apps/desktop/src/lib/browser-project/constants.ts` | 31 |
| `parseBrowserRoot` | Function | `apps/desktop/src/lib/browser-project/constants.ts` | 43 |
| `relativeFromBrowserAbsolute` | Function | `apps/desktop/src/lib/browser-project/constants.ts` | 62 |
| `getFsaDirectoryAtRelativePath` | Function | `apps/desktop/src/lib/browser-project/fsa-store.ts` | 14 |
| `writeFsaFile` | Function | `apps/desktop/src/lib/browser-project/fsa-store.ts` | 34 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleCreate → OpfsProjectsRoot` | cross_community | 9 |
| `HandleCreate → OpfsProjectsRoot` | cross_community | 9 |
| `HandleCreate → GetFsaDirectoryAtRelativePath` | cross_community | 7 |
| `HandleCreate → GetFsaDirectoryAtRelativePath` | cross_community | 7 |
| `ImportDroppedBrowserFiles → OpfsProjectsRoot` | cross_community | 7 |
| `HandleCreate → ParseBrowserRoot` | cross_community | 6 |
| `HandleCreate → BrowserRootPath` | cross_community | 6 |
| `HandleCreate → RelativeFromBrowserAbsolute` | cross_community | 6 |
| `HandlePaste → ParseBrowserRoot` | cross_community | 6 |
| `HandlePaste → BrowserRootPath` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Semantic-layer | 4 calls |
| Stores | 2 calls |
| Editor | 1 calls |
| Hooks | 1 calls |

## How to Explore

1. `context({name: "refreshFiles"})` — see callers and callees
2. `query({search_query: "browser-project"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
