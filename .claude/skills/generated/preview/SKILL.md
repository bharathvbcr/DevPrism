---
name: preview
description: "Skill for the Preview area of DevPrism. 121 symbols across 17 files."
---

# Preview

121 symbols | 17 files | Cohesion: 75%

## When to Use

- Working with code in `apps/`
- Understanding how setPdfData, setCompileError, setIsCompiling work
- Modifying preview-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | setPdfData, setCompileError, setIsCompiling, saveAllFiles, compile (+44) |
| `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | PdfViewer, scrollToMatch, goToMatch, getVisiblePage, scrollToPage (+31) |
| `apps/desktop/src/lib/latex-compiler.ts` | resolveCompileTarget, formatCompileError, buildCompileStateContext, compileLatex, synctexEdit (+2) |
| `apps/desktop/src/lib/pdf-zoom.ts` | zoomSelectValue, clampScale, computeFitScale, settleScale, settleSize |
| `apps/desktop/src/lib/compile-root-preference.ts` | resolveActiveCompileTarget, setCompileRootPreference, clearCompileRootPreference |
| `apps/desktop/src/components/ui/select.tsx` | SelectGroup, SelectLabel, SelectSeparator |
| `apps/desktop/src/stores/annotation-store.ts` | useAnnotationStore, getHighlightColor, getHighlightsForRoot |
| `apps/desktop/src/lib/pdf-text-selection.ts` | mergeClientRectsToQuads, isSelectionInPdfTextLayer, inLayer |
| `apps/desktop/src/hooks/use-claude-events.ts` | cleanupTemporaryFiles, handleComplete |
| `apps/desktop/src/lib/agent-backend.ts` | isClaudeCodeBackend, backendShowsSessionHistory |

## Entry Points

Start here when exploring this area:

- **`setPdfData`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:312`
- **`setCompileError`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:313`
- **`setIsCompiling`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:314`
- **`saveAllFiles`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:321`
- **`compile`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:951`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `setPdfData` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 312 |
| `setCompileError` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 313 |
| `setIsCompiling` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 314 |
| `saveAllFiles` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 321 |
| `compile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 951 |
| `handleCompile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1221 |
| `handleComplete` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 374 |
| `onCompile` | Function | `apps/desktop/src/hooks/use-compile-request.ts` | 7 |
| `isClaudeCodeBackend` | Function | `apps/desktop/src/lib/agent-backend.ts` | 93 |
| `backendShowsSessionHistory` | Function | `apps/desktop/src/lib/agent-backend.ts` | 107 |
| `resolveActiveCompileTarget` | Function | `apps/desktop/src/lib/compile-root-preference.ts` | 51 |
| `resolveCompileTarget` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 70 |
| `formatCompileError` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 99 |
| `buildCompileStateContext` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 196 |
| `compileLatex` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 240 |
| `compileActiveProject` | Function | `apps/desktop/src/lib/project-compile.ts` | 8 |
| `getPdfBytes` | Function | `apps/desktop/src/stores/document-store.ts` | 63 |
| `PdfPreview` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 300 |
| `setCompilerBackend` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 302 |
| `setAutoCompile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 304 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleComplete → EvictExpired` | cross_community | 6 |
| `HandleComplete → EvictLru` | cross_community | 6 |
| `HandleComplete → IsTauri` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeGroqBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeApiBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeOllamaBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsCursorCliBackend` | cross_community | 5 |
| `HandleBulletAiSuggestion → InlineEditChatPrompt` | cross_community | 5 |
| `LatexEditor → ResolveTexRoot` | cross_community | 4 |
| `HandlePdfToolbarAction → ShowWorkspaceBanner` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Editor | 16 calls |
| Career | 12 calls |
| Mupdf | 7 calls |
| Ui | 5 calls |
| Stores | 4 calls |
| Rich | 2 calls |
| Semantic-layer | 1 calls |
| Cluster_358 | 1 calls |

## How to Explore

1. `context({name: "setPdfData"})` — see callers and callees
2. `query({search_query: "preview"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
