---
name: tauri
description: "Skill for the Tauri area of devprism-main. 11 symbols across 4 files."
---

# Tauri

11 symbols | 4 files | Cohesion: 95%

## When to Use

- Working with code in `apps/`
- Understanding how offsetToLineCol, getUniqueTargetName, copyFileToProject work
- Modifying tauri-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/tauri/fs.ts` | getUniqueTargetName, copyFileToProject, shouldSkipProjectDirectory, getProjectFileType, scanProjectFolder (+2) |
| `apps/desktop/src/components/agent-chat/chat-composer.tsx` | getFileIcon, ChatComposer |
| `apps/desktop/src/stores/agent-chat-store.ts` | offsetToLineCol |
| `apps/desktop/src/components/workspace/editor/image-preview.tsx` | ImagePreview |

## Entry Points

Start here when exploring this area:

- **`offsetToLineCol`** (Function) — `apps/desktop/src/stores/agent-chat-store.ts:11`
- **`getUniqueTargetName`** (Function) — `apps/desktop/src/lib/tauri/fs.ts:270`
- **`copyFileToProject`** (Function) — `apps/desktop/src/lib/tauri/fs.ts:293`
- **`ChatComposer`** (Function) — `apps/desktop/src/components/agent-chat/chat-composer.tsx:66`
- **`shouldSkipProjectDirectory`** (Function) — `apps/desktop/src/lib/tauri/fs.ts:129`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `offsetToLineCol` | Function | `apps/desktop/src/stores/agent-chat-store.ts` | 11 |
| `getUniqueTargetName` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 270 |
| `copyFileToProject` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 293 |
| `ChatComposer` | Function | `apps/desktop/src/components/agent-chat/chat-composer.tsx` | 66 |
| `shouldSkipProjectDirectory` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 129 |
| `getProjectFileType` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 135 |
| `scanProjectFolder` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 159 |
| `walk` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 163 |
| `getAssetUrl` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 243 |
| `ImagePreview` | Function | `apps/desktop/src/components/workspace/editor/image-preview.tsx` | 41 |
| `getFileIcon` | Function | `apps/desktop/src/components/agent-chat/chat-composer.tsx` | 52 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Ui | 1 calls |

## How to Explore

1. `gitnexus_context({name: "offsetToLineCol"})` — see callers and callees
2. `gitnexus_query({query: "tauri"})` — find related execution flows
3. Read key files listed above for implementation details
