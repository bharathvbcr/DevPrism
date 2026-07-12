---
name: mupdf
description: "Skill for the Mupdf area of DevPrism. 48 symbols across 9 files."
---

# Mupdf

48 symbols | 9 files | Cohesion: 79%

## When to Use

- Working with code in `apps/`
- Understanding how closePreview, handleOpenChange, MupdfPage work
- Modifying mupdf-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | openDocument, closeDocument, countPages, getAllPageSizes, drawPage (+22) |
| `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | computeFingerprint, evictOldest, getCachedDocument, getOrOpenDocument, invalidateDoc |
| `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | isCanvasBlank, MupdfPage, renderPage, handleVisibilityRestored |
| `apps/desktop/src/lib/template-preview-cache.ts` | notify, getTemplatePdfUrl, generateThumbnail, prefetchThumbnails |
| `apps/desktop/src/components/template-gallery/template-preview.tsx` | closePreview, handleOpenChange |
| `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | flattenPageText, runSummarize |
| `apps/desktop/src/lib/career/ingest/pdf.ts` | flattenPageText, extractPdfPages |
| `apps/desktop/src/components/project-picker.tsx` | renderPdfThumbnailFromBytes |
| `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | runLiteralSearch |

## Entry Points

Start here when exploring this area:

- **`closePreview`** (Function) — `apps/desktop/src/components/template-gallery/template-preview.tsx:75`
- **`handleOpenChange`** (Function) — `apps/desktop/src/components/template-gallery/template-preview.tsx:123`
- **`MupdfPage`** (Function) — `apps/desktop/src/components/workspace/preview/mupdf-page.tsx:146`
- **`renderPage`** (Function) — `apps/desktop/src/components/workspace/preview/mupdf-page.tsx:183`
- **`handleVisibilityRestored`** (Function) — `apps/desktop/src/components/workspace/preview/mupdf-page.tsx:253`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `closePreview` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 75 |
| `handleOpenChange` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 123 |
| `MupdfPage` | Function | `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | 146 |
| `renderPage` | Function | `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | 183 |
| `handleVisibilityRestored` | Function | `apps/desktop/src/components/workspace/preview/mupdf-page.tsx` | 253 |
| `runSummarize` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 1147 |
| `flattenPageText` | Function | `apps/desktop/src/lib/career/ingest/pdf.ts` | 16 |
| `extractPdfPages` | Function | `apps/desktop/src/lib/career/ingest/pdf.ts` | 32 |
| `getMupdfClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 156 |
| `getCachedDocument` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 59 |
| `getOrOpenDocument` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 74 |
| `invalidateDoc` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 111 |
| `runLiteralSearch` | Function | `apps/desktop/src/components/workspace/preview/pdf-viewer.tsx` | 534 |
| `getTemplatePdfUrl` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 33 |
| `generateThumbnail` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 37 |
| `prefetchThumbnails` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 85 |
| `resetMupdfClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 164 |
| `openDocument` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 12 |
| `closeDocument` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 13 |
| `countPages` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 14 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CloseProject → CreateClient` | cross_community | 4 |
| `RunSummarize → IsOllamaEndpoint` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Career | 2 calls |
| Preview | 1 calls |
| Editor | 1 calls |
| Components | 1 calls |
| Ui | 1 calls |

## How to Explore

1. `context({name: "closePreview"})` — see callers and callees
2. `query({search_query: "mupdf"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
