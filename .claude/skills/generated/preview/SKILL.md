---
name: preview
description: "Skill for the Preview area of DevPrism. 132 symbols across 19 files."
---

# Preview

132 symbols | 19 files | Cohesion: 73%

## When to Use

- Working with code in `apps/`
- Understanding how ArtifactPreview, PdfPreview, setCompilerBackend work
- Modifying preview-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | PdfPreview, setCompilerBackend, setAutoCompile, setPdfDarkMode, setActiveColor (+44) |
| `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | clampPdfScale, findPageZoomAnchor, handleKeyDown, zoomAtPoint, readGestureScale (+33) |
| `apps/desktop/src/lib/latex-compiler.ts` | resolveCompileTarget, formatCompileError, buildCompileStateContext, compileLatex, synctexEdit (+2) |
| `apps/desktop/src/lib/pdf-zoom.ts` | zoomSelectValue, clampScale, computeFitScale, settleScale, settleSize |
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | drawPage, getPageText, getPageLinks, searchPage, exportAnnotatedPdf |
| `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | isCanvasBlank, MupdfPage, renderPage, handleVisibilityRestored |
| `apps/desktop/src/components/ui/select.tsx` | SelectGroup, SelectLabel, SelectSeparator |
| `apps/desktop/src/lib/compile-root-preference.ts` | setCompileRootPreference, clearCompileRootPreference, resolveActiveCompileTarget |
| `apps/desktop/src/stores/annotation-store.ts` | useAnnotationStore, getHighlightColor, getHighlightsForRoot |
| `apps/desktop/src/lib/pdf-text-selection.ts` | mergeClientRectsToQuads, isSelectionInPdfTextLayer, inLayer |

## Entry Points

Start here when exploring this area:

- **`ArtifactPreview`** (Function) — `apps/desktop/src/components/workspace/preview/artifact-preview.tsx:100`
- **`PdfPreview`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:300`
- **`setCompilerBackend`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:302`
- **`setAutoCompile`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:304`
- **`setPdfDarkMode`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:306`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ArtifactPreview` | Function | `apps/desktop/src/components/workspace/preview/artifact-preview.tsx` | 100 |
| `PdfPreview` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 300 |
| `setCompilerBackend` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 302 |
| `setAutoCompile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 304 |
| `setPdfDarkMode` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 306 |
| `setActiveColor` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 489 |
| `clearHighlights` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 490 |
| `goToPage` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1081 |
| `handlePageInputCommit` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1106 |
| `handleCopyCaption` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1359 |
| `createAutoCompileScheduler` | Function | `apps/desktop/src/lib/auto-compile.ts` | 35 |
| `setCompileRootPreference` | Function | `apps/desktop/src/lib/compile-root-preference.ts` | 13 |
| `clearCompileRootPreference` | Function | `apps/desktop/src/lib/compile-root-preference.ts` | 20 |
| `zoomSelectValue` | Function | `apps/desktop/src/lib/pdf-zoom.ts` | 120 |
| `setPdfData` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 312 |
| `setCompileError` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 313 |
| `setIsCompiling` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 314 |
| `saveAllFiles` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 321 |
| `compile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 951 |
| `handleCompile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1221 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleComplete → EvictExpired` | cross_community | 6 |
| `HandleComplete → EvictLru` | cross_community | 6 |
| `HandleComplete → IsTauri` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeGroqBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeOllamaBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsCursorCliBackend` | cross_community | 5 |
| `ClaudeChatDrawer → IsNativeBackend` | cross_community | 5 |
| `HandleBulletAiSuggestion → InlineEditChatPrompt` | cross_community | 5 |
| `LatexEditor → ResolveTexRoot` | cross_community | 4 |
| `HandlePdfToolbarAction → ShowWorkspaceBanner` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 22 calls |
| Editor | 12 calls |
| Ui | 7 calls |
| Mupdf | 7 calls |
| Components | 2 calls |
| Stores | 2 calls |
| Rich | 2 calls |
| Semantic-layer | 1 calls |

## How to Explore

1. `context({name: "ArtifactPreview"})` — see callers and callees
2. `query({search_query: "preview"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
