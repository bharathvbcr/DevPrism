---
name: preview
description: "Skill for the Preview area of DevPrism. 125 symbols across 18 files."
---

# Preview

125 symbols | 18 files | Cohesion: 74%

## When to Use

- Working with code in `apps/`
- Understanding how ArtifactPreview, PdfPreview, setCompilerBackend work
- Modifying preview-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | PdfPreview, setCompilerBackend, setAutoCompile, setPdfDarkMode, setActiveColor (+42) |
| `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | PdfViewer, getVisiblePage, scrollToPage, scrollToPageEl, attempt (+31) |
| `apps/desktop/src/lib/latex-compiler.ts` | resolveCompileTarget, formatCompileError, buildCompileStateContext, compileLatex, synctexEdit (+2) |
| `apps/desktop/src/lib/pdf-zoom.ts` | zoomSelectValue, clampScale, computeFitScale, settleScale, settleSize |
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | drawPage, getPageText, getPageLinks, exportAnnotatedPdf, searchPage |
| `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | isCanvasBlank, MupdfPage, renderPage, handleVisibilityRestored |
| `apps/desktop/src/components/ui/select.tsx` | SelectGroup, SelectLabel, SelectSeparator |
| `apps/desktop/src/lib/compile-root-preference.ts` | setCompileRootPreference, clearCompileRootPreference, resolveActiveCompileTarget |
| `apps/desktop/src/stores/annotation-store.ts` | useAnnotationStore, getHighlightsForRoot, getHighlightColor |
| `apps/desktop/src/components/workspace/preview/artifact-preview.tsx` | ArtifactSummarize, ArtifactPreview |

## Entry Points

Start here when exploring this area:

- **`ArtifactPreview`** (Function) — `apps/desktop/src/components/workspace/preview/artifact-preview.tsx:100`
- **`PdfPreview`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:299`
- **`setCompilerBackend`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:301`
- **`setAutoCompile`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:303`
- **`setPdfDarkMode`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:305`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ArtifactPreview` | Function | `apps/desktop/src/components/workspace/preview/artifact-preview.tsx` | 100 |
| `PdfPreview` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 299 |
| `setCompilerBackend` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 301 |
| `setAutoCompile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 303 |
| `setPdfDarkMode` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 305 |
| `setActiveColor` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 484 |
| `clearHighlights` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 485 |
| `goToPage` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1059 |
| `handlePageInputCommit` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1084 |
| `handleCopyCaption` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1337 |
| `createAutoCompileScheduler` | Function | `apps/desktop/src/lib/auto-compile.ts` | 35 |
| `setCompileRootPreference` | Function | `apps/desktop/src/lib/compile-root-preference.ts` | 13 |
| `clearCompileRootPreference` | Function | `apps/desktop/src/lib/compile-root-preference.ts` | 20 |
| `zoomSelectValue` | Function | `apps/desktop/src/lib/pdf-zoom.ts` | 120 |
| `handleComplete` | Function | `apps/desktop/src/hooks/use-claude-events.ts` | 359 |
| `onCompile` | Function | `apps/desktop/src/hooks/use-compile-request.ts` | 7 |
| `setPdfData` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 311 |
| `setCompileError` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 312 |
| `setIsCompiling` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 313 |
| `saveAllFiles` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 320 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleComplete → EvictExpired` | cross_community | 6 |
| `HandleComplete → EvictLru` | cross_community | 6 |
| `ClaudeChatDrawer → ResolveSemanticConfig` | cross_community | 6 |
| `Handle → IsOllamaEndpoint` | cross_community | 6 |
| `Handle → ResolveSemanticConfig` | cross_community | 6 |
| `Handle → EmbedText` | cross_community | 6 |
| `Handle → FormatCompressedContext` | cross_community | 6 |
| `HandleComplete → IsTauri` | cross_community | 5 |
| `HandleBulletAiSuggestion → InlineEditChatPrompt` | cross_community | 5 |
| `ClaudeChatDrawer → ExtractLastAssistantText` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 25 calls |
| Editor | 11 calls |
| Ui | 7 calls |
| Mupdf | 6 calls |
| Rich | 2 calls |
| Semantic-layer | 1 calls |
| Cluster_318 | 1 calls |

## How to Explore

1. `context({name: "ArtifactPreview"})` — see callers and callees
2. `query({search_query: "preview"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
