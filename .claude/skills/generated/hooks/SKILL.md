---
name: hooks
description: "Skill for the Hooks area of DevPrism. 33 symbols across 14 files."
---

# Hooks

33 symbols | 14 files | Cohesion: 78%

## When to Use

- Working with code in `apps/`
- Understanding how hasPdfData, handleComplete, resolveCompileTarget work
- Modifying hooks-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/hooks/use-claude-events.ts` | cleanupTemporaryFiles, handleComplete, useClaudeEvents, setUserVisibleError, providerErrorMessage (+2) |
| `apps/desktop/src/lib/app-zoom.ts` | getAppZoomAction, shouldHandleAppZoomShortcut, hasLocalZoomSurfaceAtPoint, hasLocalZoomSurfaceInPath, shouldHandleNativeWheelZoom |
| `apps/desktop/src/lib/latex-compiler.ts` | resolveCompileTarget, formatCompileError, compileLatex |
| `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | compile, handleCompile, dispatchEvent |
| `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | handleZoomKeyDown, useKeyboardShortcuts, handleKeyDown |
| `apps/desktop/src/components/workspace/editor/export-menu.tsx` | ExportMenu, runExport |
| `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx` | ClaudeChatDrawer, panelStyle |
| `apps/desktop/src/lib/personalization.ts` | scheduleIdentityProfileSync, syncPersonalizationEnabled |
| `apps/desktop/src/stores/document-store.ts` | hasPdfData |
| `apps/desktop/src/lib/compile-root-preference.ts` | getCompileRootPreference |

## Entry Points

Start here when exploring this area:

- **`hasPdfData`** (Function) — `apps/desktop/src/stores/document-store.ts:74`
- **`handleComplete`** (Function) — `apps/desktop/src/hooks/use-claude-events.ts:357`
- **`resolveCompileTarget`** (Function) — `apps/desktop/src/lib/latex-compiler.ts:62`
- **`formatCompileError`** (Function) — `apps/desktop/src/lib/latex-compiler.ts:91`
- **`compileLatex`** (Function) — `apps/desktop/src/lib/latex-compiler.ts:99`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `hasPdfData` | Function | `apps/desktop/src/stores/document-store.ts` | 74 |
| `handleComplete` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 357 |
| `resolveCompileTarget` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 62 |
| `formatCompileError` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 91 |
| `compileLatex` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 99 |
| `getCompileRootPreference` | Function | `apps/desktop/src/lib/compile-root-preference.ts` | 4 |
| `compile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 759 |
| `handleCompile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1008 |
| `ExportMenu` | Function | `apps/desktop/src/components/workspace/editor/export-menu.tsx` | 26 |
| `runExport` | Function | `apps/desktop/src/components/workspace/editor/export-menu.tsx` | 33 |
| `useClaudeEvents` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 61 |
| `setUserVisibleError` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 105 |
| `providerErrorMessage` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 110 |
| `elapsed` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 176 |
| `handleStreamMessage` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 182 |
| `ClaudeChatDrawer` | Function | `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx` | 21 |
| `panelStyle` | Function | `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx` | 120 |
| `handleZoomKeyDown` | Function | `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | 7 |
| `getAppZoomAction` | Function | `apps/desktop/src/lib/app-zoom.ts` | 66 |
| `shouldHandleAppZoomShortcut` | Function | `apps/desktop/src/lib/app-zoom.ts` | 102 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ClaudeChatDrawer → Norm` | cross_community | 5 |
| `ClaudeChatDrawer → ReadTexFileContent` | cross_community | 5 |
| `ClaudeChatDrawer → ResolveTexRoot` | cross_community | 5 |
| `ClaudeChatDrawer → Elapsed` | intra_community | 4 |
| `ClaudeChatDrawer → SetUserVisibleError` | intra_community | 4 |
| `ClaudeChatDrawer → CleanupTemporaryFiles` | cross_community | 4 |
| `ClaudeChatDrawer → CompileLatex` | cross_community | 4 |
| `ClaudeChatDrawer → FormatCompileError` | cross_community | 4 |
| `LatexEditor → ResolveTexRoot` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Editor | 2 calls |
| Ui | 2 calls |
| Native_agent | 1 calls |
| Stores | 1 calls |

## How to Explore

1. `gitnexus_context({name: "hasPdfData"})` — see callers and callees
2. `gitnexus_query({query: "hooks"})` — find related execution flows
3. Read key files listed above for implementation details
