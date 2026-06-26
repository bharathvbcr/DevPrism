---
name: preview
description: "Skill for the Preview area of DevPrism. 48 symbols across 10 files."
---

# Preview

48 symbols | 10 files | Cohesion: 77%

## When to Use

- Working with code in `apps/`
- Understanding how PdfViewer, runLiteralSearch, getVisiblePage work
- Modifying preview-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | clampPdfScale, findPageZoomAnchor, PdfViewer, runLiteralSearch, getVisiblePage (+22) |
| `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | findSourceSpan, flattenPageText, PdfPreview, renderContent, handleExplainErrors (+1) |
| `apps/desktop/src/stores/document-store.ts` | getCurrentPdfRootId, getPdfBytes, clearPdfBytesCache |
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | searchPage, getPageText |
| `apps/desktop/src/lib/latex-compiler.ts` | listCompileRoots, synctexEdit |
| `apps/desktop/src/lib/auto-compile.ts` | createAutoCompileScheduler, clear |
| `apps/desktop/src/lib/ai-assist.ts` | aiCompleteStream, explainCompileErrorsStream |
| `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | isCanvasBlank, handleVisibilityRestored |
| `apps/desktop/src/stores/annotation-store.ts` | getHighlightColor |
| `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | clearEditorStateCache |

## Entry Points

Start here when exploring this area:

- **`PdfViewer`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:251`
- **`runLiteralSearch`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:485`
- **`getVisiblePage`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:626`
- **`scrollToPage`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:643`
- **`scrollToPageEl`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:716`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `PdfViewer` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 251 |
| `runLiteralSearch` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 485 |
| `getVisiblePage` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 626 |
| `scrollToPage` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 643 |
| `scrollToPageEl` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 716 |
| `attempt` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 717 |
| `cancelPendingSelection` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 895 |
| `handleMouseDown` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 902 |
| `handleMouseUp` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 906 |
| `handleScroll` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 1018 |
| `getCurrentPdfRootId` | Function | `apps/desktop/src/stores/document-store.ts` | 69 |
| `getHighlightColor` | Function | `apps/desktop/src/stores/annotation-store.ts` | 18 |
| `listCompileRoots` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 20 |
| `synctexEdit` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 161 |
| `createAutoCompileScheduler` | Function | `apps/desktop/src/lib/auto-compile.ts` | 35 |
| `PdfPreview` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 190 |
| `handleWheel` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 1117 |
| `getPdfBytes` | Function | `apps/desktop/src/stores/document-store.ts` | 57 |
| `aiCompleteStream` | Function | `apps/desktop/src/lib/ai-assist.ts` | 99 |
| `explainCompileErrorsStream` | Function | `apps/desktop/src/lib/ai-assist.ts` | 336 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PdfViewer → Has` | cross_community | 6 |
| `PdfViewer → IsOllamaEndpoint` | cross_community | 6 |
| `PdfViewer → ResolveNativeOllamaModel` | cross_community | 5 |
| `PdfViewer → TryParseJson` | cross_community | 4 |
| `PdfPreview → Has` | cross_community | 3 |
| `PdfViewer → SearchPage` | intra_community | 3 |
| `Run → Clear` | cross_community | 3 |
| `HandleWheel → ClampZoomFactor` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Editor | 10 calls |
| Mupdf | 5 calls |
| Hooks | 4 calls |
| Stores | 3 calls |
| Cluster_179 | 1 calls |
| Workspace | 1 calls |
| Components | 1 calls |
| Ui | 1 calls |

## How to Explore

1. `gitnexus_context({name: "PdfViewer"})` — see callers and callees
2. `gitnexus_query({query: "preview"})` — find related execution flows
3. Read key files listed above for implementation details
