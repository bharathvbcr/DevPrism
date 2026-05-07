---
name: preview
description: "Skill for the Preview area of devprism-main. 11 symbols across 2 files."
---

# Preview

11 symbols | 2 files | Cohesion: 92%

## When to Use

- Working with code in `apps/`
- Understanding how PdfViewer, getVisiblePage, scrollToPage work
- Modifying preview-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | PdfViewer, getVisiblePage, scrollToPage, scrollToPageEl, attempt (+4) |
| `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | isCanvasBlank, handleVisibilityRestored |

## Entry Points

Start here when exploring this area:

- **`PdfViewer`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:61`
- **`getVisiblePage`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:142`
- **`scrollToPage`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:159`
- **`scrollToPageEl`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:232`
- **`attempt`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx:233`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `PdfViewer` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 61 |
| `getVisiblePage` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 142 |
| `scrollToPage` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 159 |
| `scrollToPageEl` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 232 |
| `attempt` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 233 |
| `cancelPendingSelection` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 397 |
| `handleMouseDown` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 404 |
| `handleMouseUp` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 408 |
| `handleScroll` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 475 |
| `handleVisibilityRestored` | Function | `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | 110 |
| `isCanvasBlank` | Function | `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | 19 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PdfViewer → ScrollToPage` | intra_community | 4 |
| `PdfViewer → ComputeFingerprint` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Mupdf | 2 calls |

## How to Explore

1. `gitnexus_context({name: "PdfViewer"})` — see callers and callees
2. `gitnexus_query({query: "preview"})` — find related execution flows
3. Read key files listed above for implementation details
