---
name: stores
description: "Skill for the Stores area of DevPrism. 206 symbols across 35 files."
---

# Stores

206 symbols | 35 files | Cohesion: 83%

## When to Use

- Working with code in `apps/`
- Understanding how queueGuidance, consumeQueuedGuidance, displayQueuedGuidanceInChat work
- Modifying stores-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/stores/claude-chat-store.ts` | usageFromMessage, usageTotalsForMessages, nextGuidanceId, applyTabUpdate, mergeStreamingContent (+51) |
| `apps/desktop/src/stores/document-store.ts` | clearPdfBytesCache, normalizeProjectRoot, splitProjectRoot, buildRenamedProjectRoot, sleep (+20) |
| `apps/desktop/src/stores/claude-setup-store.ts` | advanceSteps, install, _advanceInstallStep, _failCurrentStep, _advanceLoginStep (+9) |
| `apps/desktop/src/stores/personalization-store.ts` | cleanLatexText, extractFirstMatch, simpleHash, updateProfile, addResearchInterest (+7) |
| `apps/desktop/src/stores/zotero-store.ts` | connectWithOAuth, connectWithApiKey, revalidate, loadCollections, storeKey (+6) |
| `apps/desktop/src/stores/comments-store.ts` | snapshotReplyCounts, snapshotIds, fileShortName, summarizeBody, attachToProject (+5) |
| `apps/desktop/src/stores/variants-store.ts` | prepareForSwitch, create, switchTo, remove, deriveOwner (+5) |
| `apps/desktop/src/stores/file-marks-store.ts` | markKey, projectMarks, pruneEmpty, getMark, togglePin (+3) |
| `apps/desktop/src/stores/project-store.ts` | resolveRecentProjectName, recentProjectName, addRecentProject, normalizeRecentPath, isSameProjectPath (+3) |
| `apps/desktop/src/lib/tauri/comments.ts` | listComments, addComment, updateComment, replyToComment, startCommentsWatcher (+1) |

## Entry Points

Start here when exploring this area:

- **`queueGuidance`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1369`
- **`consumeQueuedGuidance`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1388`
- **`displayQueuedGuidanceInChat`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1423`
- **`removeQueuedGuidance`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1441`
- **`clearQueuedGuidance`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1465`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `queueGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1369 |
| `consumeQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1388 |
| `displayQueuedGuidanceInChat` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1423 |
| `removeQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1441 |
| `clearQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1465 |
| `consumeTemporaryFilePaths` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1475 |
| `forceQueuedGuidanceNow` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1487 |
| `cancelExecution` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1548 |
| `clearMessages` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1626 |
| `_appendMessage` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2016 |
| `_setSessionId` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2073 |
| `_setStreaming` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2090 |
| `_setError` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2102 |
| `handle` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2108 |
| `clearEditorStateCache` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 200 |
| `clearZoomCache` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 181 |
| `clearScrollPositionCache` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 203 |
| `clearAllHighlights` | Function | `apps/desktop/src/stores/annotation-store.ts` | 120 |
| `clearPdfBytesCache` | Function | `apps/desktop/src/stores/document-store.ts` | 84 |
| `openProject` | Function | `apps/desktop/src/stores/document-store.ts` | 416 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `OpenProject → GetFsaRoot` | cross_community | 5 |
| `OpenProject → OpenDb` | cross_community | 5 |
| `OpenProject → RegisterFsaRoot` | cross_community | 5 |
| `OpenProject → ParseBrowserRoot` | cross_community | 5 |
| `OpenProject → BrowserJoin` | cross_community | 5 |
| `RenameProject → NormalizeProjectRoot` | intra_community | 4 |
| `ResumeSession → ProviderSelectionStorage` | cross_community | 4 |
| `ResumeSession → ProviderSessionKey` | intra_community | 4 |
| `CloseProject → CreateClient` | cross_community | 4 |
| `AnalyzeLaTeXContent → IsOllamaEndpoint` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 11 calls |
| Browser-project | 10 calls |
| Semantic-layer | 5 calls |
| Cluster_361 | 4 calls |
| Claude-chat | 4 calls |
| Editor | 4 calls |
| Cluster_331 | 2 calls |
| Mupdf | 2 calls |

## How to Explore

1. `context({name: "queueGuidance"})` — see callers and callees
2. `query({search_query: "stores"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
