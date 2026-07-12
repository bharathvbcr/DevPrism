---
name: stores
description: "Skill for the Stores area of DevPrism. 257 symbols across 46 files."
---

# Stores

257 symbols | 46 files | Cohesion: 81%

## When to Use

- Working with code in `apps/`
- Understanding how loadSelectedProviderCredentialId, setSelectedProviderCredentialId, retryLastPrompt work
- Modifying stores-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/stores/claude-chat-store.ts` | providerSelectionStorage, loadSelectedProviderCredentialId, persistSelectedProviderCredentialId, makeDefaultTab, providerSessionKey (+60) |
| `apps/desktop/src/stores/document-store.ts` | clearPdfBytesCache, normalizeProjectRoot, splitProjectRoot, buildRenamedProjectRoot, sleep (+20) |
| `apps/desktop/src/stores/claude-setup-store.ts` | advanceSteps, install, _advanceInstallStep, _failCurrentStep, _advanceLoginStep (+9) |
| `apps/desktop/src/stores/personalization-store.ts` | cleanLatexText, extractFirstMatch, simpleHash, updateProfile, addResearchInterest (+7) |
| `apps/desktop/src/lib/agent-backend.ts` | isNativeOllamaBackend, isNativeApiBackend, isNativeGroqBackend, isCursorCliBackend, isGroqBaseUrl (+6) |
| `apps/desktop/src/stores/zotero-store.ts` | connectWithOAuth, connectWithApiKey, revalidate, loadCollections, storeKey (+6) |
| `apps/desktop/src/stores/comments-store.ts` | snapshotReplyCounts, snapshotIds, fileShortName, summarizeBody, attachToProject (+5) |
| `apps/desktop/src/stores/variants-store.ts` | deriveOwner, sync, refresh, prepareForSwitch, create (+5) |
| `apps/desktop/src/stores/file-marks-store.ts` | markKey, projectMarks, pruneEmpty, getMark, togglePin (+3) |
| `apps/desktop/src/stores/project-store.ts` | normalizeRecentPath, isSameProjectPath, commit, removeRecentProject, renameRecentProject (+3) |

## Entry Points

Start here when exploring this area:

- **`loadSelectedProviderCredentialId`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:52`
- **`setSelectedProviderCredentialId`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:966`
- **`retryLastPrompt`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1790`
- **`resetForProject`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1841`
- **`newSession`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1885`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `loadSelectedProviderCredentialId` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 52 |
| `setSelectedProviderCredentialId` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 966 |
| `retryLastPrompt` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1790 |
| `resetForProject` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1841 |
| `newSession` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1885 |
| `resumeSession` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1953 |
| `createTab` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2108 |
| `closeTab` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2142 |
| `setActiveTab` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2189 |
| `_clearStreamWatchdog` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2377 |
| `prepHeartbeat` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1207 |
| `queueGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1555 |
| `consumeQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1574 |
| `displayQueuedGuidanceInChat` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1609 |
| `removeQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1627 |
| `clearQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1651 |
| `consumeTemporaryFilePaths` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1661 |
| `forceQueuedGuidanceNow` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1673 |
| `cancelExecution` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1740 |
| `_appendMessage` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2223 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `OpenProject → GetFsaRoot` | cross_community | 5 |
| `OpenProject → OpenDb` | cross_community | 5 |
| `OpenProject → RegisterFsaRoot` | cross_community | 5 |
| `OpenProject → ParseBrowserRoot` | cross_community | 5 |
| `OpenProject → BrowserJoin` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeGroqBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeApiBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeOllamaBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsCursorCliBackend` | cross_community | 5 |
| `HandlePdfToolbarAction → ShowWorkspaceBanner` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Browser-project | 10 calls |
| Semantic-layer | 5 calls |
| Claude-chat | 5 calls |
| Editor | 5 calls |
| Cluster_412 | 4 calls |
| Workspace | 4 calls |
| Components | 4 calls |
| Career | 3 calls |

## How to Explore

1. `context({name: "loadSelectedProviderCredentialId"})` — see callers and callees
2. `query({search_query: "stores"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
