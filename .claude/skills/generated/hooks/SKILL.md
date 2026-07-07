---
name: hooks
description: "Skill for the Hooks area of DevPrism. 32 symbols across 11 files."
---

# Hooks

32 symbols | 11 files | Cohesion: 82%

## When to Use

- Working with code in `apps/`
- Understanding how recommendedIds, spaceForProject, resolved work
- Modifying hooks-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/hooks/use-claude-events.ts` | useClaudeEvents, setUserVisibleError, providerErrorMessage, registerProposedChange, norm (+2) |
| `apps/desktop/src/lib/space-features.ts` | isSpaceKind, inferSpaceKind, inferSpaceKindFromProjectPath, spaceFeatureConfig, recommendedTemplateIdsForKind |
| `apps/desktop/src/lib/app-zoom.ts` | getAppZoomAction, shouldHandleAppZoomShortcut, hasLocalZoomSurfaceAtPoint, hasLocalZoomSurfaceInPath, shouldHandleNativeWheelZoom |
| `apps/desktop/src/hooks/use-ollama-model-capabilities.ts` | cacheKey, useOllamaModelCapabilities, refresh, peekCachedOllamaModelCapabilities, useOllamaModelsCapabilities |
| `apps/desktop/src/hooks/use-space-features.ts` | spaceForProject, resolved |
| `apps/desktop/src/hooks/use-ollama-model-pull.ts` | pullModel, pull |
| `apps/desktop/src/hooks/use-updater.ts` | useUpdater, checkForUpdate |
| `apps/desktop/src/components/template-gallery/template-gallery.tsx` | recommendedIds |
| `apps/desktop/src/stores/spaces-store.ts` | migrate |
| `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | handleZoomKeyDown |

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
| `useClaudeEvents` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 60 |
| `setUserVisibleError` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 104 |
| `providerErrorMessage` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 109 |
| `registerProposedChange` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 134 |
| `norm` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 144 |
| `elapsed` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 175 |
| `handleStreamMessage` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 181 |
| `handleZoomKeyDown` | Function | `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | 11 |
| `getAppZoomAction` | Function | `apps/desktop/src/lib/app-zoom.ts` | 69 |
| `shouldHandleAppZoomShortcut` | Function | `apps/desktop/src/lib/app-zoom.ts` | 105 |
| `useOllamaModelCapabilities` | Function | `apps/desktop/src/hooks/use-ollama-model-capabilities.ts` | 12 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ClaudeChatDrawer → IsBrowserProjectPath` | cross_community | 6 |
| `ClaudeChatDrawer → ResolveSemanticConfig` | cross_community | 6 |
| `ImportDroppedBrowserFiles → IsSpaceKind` | cross_community | 5 |
| `ImportDroppedPaths → IsSpaceKind` | cross_community | 5 |
| `ClaudeChatDrawer → Norm` | cross_community | 5 |
| `ClaudeChatDrawer → ExtractLastAssistantText` | cross_community | 5 |
| `ClaudeChatDrawer → GetCompileRootPreference` | cross_community | 5 |
| `ChatComposer → CacheKey` | cross_community | 4 |
| `ChatComposer → GetOllamaModelCapabilities` | cross_community | 4 |
| `VersionSwitcher → IsSpaceKind` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Stores | 1 calls |
| Workspace | 1 calls |
| Preview | 1 calls |

## How to Explore

1. `context({name: "recommendedIds"})` — see callers and callees
2. `query({search_query: "hooks"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
