---
name: stores
description: "Skill for the Stores area of DevPrism. 54 symbols across 11 files."
---

# Stores

54 symbols | 11 files | Cohesion: 87%

## When to Use

- Working with code in `apps/`
- Understanding how loadSelectedProviderCredentialId, resolveTexRoot, isStandaloneCompileRoot work
- Modifying stores-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/stores/claude-chat-store.ts` | truncateChatTitle, normalizeChatTitleWhitespace, isNoiseChatTitleLine, extractMarkedRequestBody, firstMeaningfulTitleLine (+22) |
| `apps/desktop/src/stores/document-store.ts` | resolveTexRoot, sleep, isWindowsFolderLockError, formatProjectRenameError, renameProjectRootWithRetry (+8) |
| `apps/desktop/src/stores/project-store.ts` | normalizeRecentPath, recentProjectName, isSameProjectPath |
| `apps/desktop/src/lib/latex-compiler.ts` | isStandaloneCompileRoot, synctexForward |
| `apps/desktop/src/lib/compile-root-preference.ts` | setCompileRootPreference, syncCompileRootForActiveFile |
| `apps/desktop/src/stores/personalization-store.ts` | cleanLatexText, extractFirstMatch |
| `apps/desktop/src/lib/forward-sync.ts` | triggerForwardSync |
| `apps/desktop/src/lib/tauri/fs.ts` | renameFileOnDisk |
| `apps/desktop/src/stores/annotation-store.ts` | getHighlightsForRoot |
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | exportAnnotatedPdf |

## Entry Points

Start here when exploring this area:

- **`loadSelectedProviderCredentialId`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:27`
- **`resolveTexRoot`** (Function) — `apps/desktop/src/stores/document-store.ts:196`
- **`isStandaloneCompileRoot`** (Function) — `apps/desktop/src/lib/latex-compiler.ts:51`
- **`synctexForward`** (Function) — `apps/desktop/src/lib/latex-compiler.ts:183`
- **`triggerForwardSync`** (Function) — `apps/desktop/src/lib/forward-sync.ts:9`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `loadSelectedProviderCredentialId` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 27 |
| `resolveTexRoot` | Function | `apps/desktop/src/stores/document-store.ts` | 196 |
| `isStandaloneCompileRoot` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 51 |
| `synctexForward` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 183 |
| `triggerForwardSync` | Function | `apps/desktop/src/lib/forward-sync.ts` | 9 |
| `setCompileRootPreference` | Function | `apps/desktop/src/lib/compile-root-preference.ts` | 8 |
| `syncCompileRootForActiveFile` | Function | `apps/desktop/src/lib/compile-root-preference.ts` | 16 |
| `renameFileOnDisk` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 297 |
| `getCurrentPdfBytes` | Function | `apps/desktop/src/stores/document-store.ts` | 62 |
| `getHighlightsForRoot` | Function | `apps/desktop/src/stores/annotation-store.ts` | 115 |
| `handleExport` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 824 |
| `messageContentText` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 273 |
| `exportAnnotatedPdf` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 28 |
| `truncateChatTitle` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 399 |
| `normalizeChatTitleWhitespace` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 405 |
| `isNoiseChatTitleLine` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 409 |
| `extractMarkedRequestBody` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 425 |
| `firstMeaningfulTitleLine` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 445 |
| `summarizeChatTitle` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 455 |
| `sanitizeAiChatTitle` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 504 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → SetCompileRootPreference` | cross_community | 6 |
| `HandleExport → Has` | cross_community | 5 |
| `ClaudeChatDrawer → ResolveTexRoot` | cross_community | 5 |
| `LatexEditor → ResolveTexRoot` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Editor | 2 calls |
| Workspace | 1 calls |
| Hooks | 1 calls |
| Mupdf | 1 calls |

## How to Explore

1. `gitnexus_context({name: "loadSelectedProviderCredentialId"})` — see callers and callees
2. `gitnexus_query({query: "stores"})` — find related execution flows
3. Read key files listed above for implementation details
