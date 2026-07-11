---
name: stores
description: "Skill for the Stores area of DevPrism. 240 symbols across 40 files."
---

# Stores

240 symbols | 40 files | Cohesion: 81%

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
| `apps/desktop/src/stores/zotero-store.ts` | connectWithOAuth, connectWithApiKey, revalidate, loadCollections, storeKey (+6) |
| `apps/desktop/src/stores/comments-store.ts` | snapshotReplyCounts, snapshotIds, fileShortName, summarizeBody, attachToProject (+5) |
| `apps/desktop/src/stores/variants-store.ts` | prepareForSwitch, create, switchTo, remove, deriveOwner (+5) |
| `apps/desktop/src/stores/file-marks-store.ts` | markKey, projectMarks, pruneEmpty, getMark, togglePin (+3) |
| `apps/desktop/src/stores/project-store.ts` | normalizeRecentPath, isSameProjectPath, commit, removeRecentProject, renameRecentProject (+3) |
| `apps/desktop/src/stores/cursor-setup-store.ts` | checkStatus, login, saveApiKey, _finishInstall, install (+3) |

## Entry Points

Start here when exploring this area:

- **`loadSelectedProviderCredentialId`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:49`
- **`setSelectedProviderCredentialId`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:957`
- **`retryLastPrompt`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1770`
- **`resetForProject`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1821`
- **`newSession`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:1865`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `loadSelectedProviderCredentialId` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 49 |
| `setSelectedProviderCredentialId` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 957 |
| `retryLastPrompt` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1770 |
| `resetForProject` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1821 |
| `newSession` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1865 |
| `resumeSession` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1933 |
| `createTab` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2088 |
| `closeTab` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2122 |
| `setActiveTab` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2169 |
| `_clearStreamWatchdog` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2362 |
| `prepHeartbeat` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1198 |
| `queueGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1535 |
| `consumeQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1554 |
| `displayQueuedGuidanceInChat` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1589 |
| `removeQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1607 |
| `clearQueuedGuidance` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1631 |
| `consumeTemporaryFilePaths` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1641 |
| `forceQueuedGuidanceNow` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1653 |
| `cancelExecution` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 1720 |
| `_appendMessage` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 2203 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `OpenProject → GetFsaRoot` | cross_community | 5 |
| `OpenProject → OpenDb` | cross_community | 5 |
| `OpenProject → RegisterFsaRoot` | cross_community | 5 |
| `OpenProject → ParseBrowserRoot` | cross_community | 5 |
| `OpenProject → BrowserJoin` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeBackend` | cross_community | 5 |
| `HandlePdfToolbarAction → ShowWorkspaceBanner` | cross_community | 4 |
| `RenameProject → NormalizeProjectRoot` | intra_community | 4 |
| `ResumeSession → ProviderSelectionStorage` | intra_community | 4 |
| `ResumeSession → ProviderSessionKey` | intra_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Browser-project | 10 calls |
| Workspace | 8 calls |
| Semantic-layer | 5 calls |
| Claude-chat | 5 calls |
| Cluster_371 | 4 calls |
| Editor | 4 calls |
| Components | 3 calls |
| Cluster_339 | 2 calls |

## How to Explore

1. `context({name: "loadSelectedProviderCredentialId"})` — see callers and callees
2. `query({search_query: "stores"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
