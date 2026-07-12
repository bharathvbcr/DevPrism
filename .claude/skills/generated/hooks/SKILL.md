---
name: hooks
description: "Skill for the Hooks area of DevPrism. 40 symbols across 15 files."
---

# Hooks

40 symbols | 15 files | Cohesion: 77%

## When to Use

- Working with code in `apps/`
- Understanding how recommendedIds, spaceForProject, resolved work
- Modifying hooks-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/hooks/use-claude-events.ts` | useClaudeEvents, setUserVisibleError, providerErrorMessage, elapsed, handleStreamMessage (+2) |
| `apps/desktop/src/lib/space-features.ts` | isSpaceKind, inferSpaceKind, inferSpaceKindFromProjectPath, spaceFeatureConfig, recommendedTemplateIdsForKind |
| `apps/desktop/src/lib/app-zoom.ts` | getAppZoomAction, shouldHandleAppZoomShortcut, hasLocalZoomSurfaceAtPoint, hasLocalZoomSurfaceInPath, shouldHandleNativeWheelZoom |
| `apps/desktop/src/hooks/use-ollama-model-capabilities.ts` | cacheKey, useOllamaModelCapabilities, refresh, peekCachedOllamaModelCapabilities, useOllamaModelsCapabilities |
| `apps/desktop/src/lib/claude-stream-heartbeat.ts` | heartbeatPhaseFromMessage, isStreamHeartbeat, hasThinkingBlock, streamActivityPhaseFromMessage |
| `apps/desktop/src/hooks/use-space-features.ts` | spaceForProject, resolved |
| `apps/desktop/src/stores/document-store.ts` | reloadFile, loadFileContent |
| `apps/desktop/src/hooks/use-ollama-model-pull.ts` | pullModel, pull |
| `apps/desktop/src/hooks/use-updater.ts` | useUpdater, checkForUpdate |
| `apps/desktop/src/components/template-gallery/template-gallery.tsx` | recommendedIds |

## Entry Points

Start here when exploring this area:

- **`recommendedIds`** (Function) — `apps/desktop/src/components/template-gallery/template-gallery.tsx:52`
- **`spaceForProject`** (Function) — `apps/desktop/src/hooks/use-space-features.ts:28`
- **`resolved`** (Function) — `apps/desktop/src/hooks/use-space-features.ts:30`
- **`isSpaceKind`** (Function) — `apps/desktop/src/lib/space-features.ts:481`
- **`inferSpaceKind`** (Function) — `apps/desktop/src/lib/space-features.ts:492`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `recommendedIds` | Function | `apps/desktop/src/components/template-gallery/template-gallery.tsx` | 52 |
| `spaceForProject` | Function | `apps/desktop/src/hooks/use-space-features.ts` | 28 |
| `resolved` | Function | `apps/desktop/src/hooks/use-space-features.ts` | 30 |
| `isSpaceKind` | Function | `apps/desktop/src/lib/space-features.ts` | 481 |
| `inferSpaceKind` | Function | `apps/desktop/src/lib/space-features.ts` | 492 |
| `inferSpaceKindFromProjectPath` | Function | `apps/desktop/src/lib/space-features.ts` | 532 |
| `spaceFeatureConfig` | Function | `apps/desktop/src/lib/space-features.ts` | 541 |
| `recommendedTemplateIdsForKind` | Function | `apps/desktop/src/lib/space-features.ts` | 565 |
| `migrate` | Function | `apps/desktop/src/stores/spaces-store.ts` | 216 |
| `useClaudeEvents` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 69 |
| `setUserVisibleError` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 113 |
| `providerErrorMessage` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 118 |
| `elapsed` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 184 |
| `handleStreamMessage` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 190 |
| `heartbeatPhaseFromMessage` | Function | `apps/desktop/src/lib/claude-stream-heartbeat.ts` | 6 |
| `isStreamHeartbeat` | Function | `apps/desktop/src/lib/claude-stream-heartbeat.ts` | 14 |
| `streamActivityPhaseFromMessage` | Function | `apps/desktop/src/lib/claude-stream-heartbeat.ts` | 26 |
| `registerProposedChange` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 143 |
| `norm` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 153 |
| `readTexFileContent` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 97 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ImportDroppedBrowserFiles → IsSpaceKind` | cross_community | 5 |
| `ImportDroppedPaths → IsSpaceKind` | cross_community | 5 |
| `ClaudeChatDrawer → HasThinkingBlock` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeGroqBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeApiBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeOllamaBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsCursorCliBackend` | cross_community | 5 |
| `VersionSwitcher → IsSpaceKind` | cross_community | 4 |
| `VersionOverview → IsSpaceKind` | cross_community | 4 |
| `Resolved → IsSpaceKind` | intra_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Stores | 2 calls |
| Browser-project | 2 calls |
| Preview | 1 calls |

## How to Explore

1. `context({name: "recommendedIds"})` — see callers and callees
2. `query({search_query: "hooks"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
