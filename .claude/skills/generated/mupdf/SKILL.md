---
name: mupdf
description: "Skill for the Mupdf area of devprism-main. 25 symbols across 6 files."
---

# Mupdf

25 symbols | 6 files | Cohesion: 70%

## When to Use

- Working with code in `apps/`
- Understanding how getTemplateById, TemplatePreview, handleRemoveAttachment work
- Modifying mupdf-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | countPages, getPageSize, drawPage, closeDocument, createClient (+5) |
| `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | evictOldest, invalidateDoc, clearDocCache, computeFingerprint, getCachedDocument (+1) |
| `apps/desktop/src/components/template-gallery/template-preview.tsx` | randomProjectName, TemplatePreview, handleRemoveAttachment |
| `apps/desktop/src/lib/template-preview-cache.ts` | notify, getTemplatePdfUrl, generateThumbnail |
| `apps/desktop/src/components/project-wizard.tsx` | ScratchForm, handleRemoveAttachment |
| `apps/desktop/src/lib/template-registry.ts` | getTemplateById |

## Entry Points

Start here when exploring this area:

- **`getTemplateById`** (Function) — `apps/desktop/src/lib/template-registry.ts:3226`
- **`TemplatePreview`** (Function) — `apps/desktop/src/components/template-gallery/template-preview.tsx:86`
- **`handleRemoveAttachment`** (Function) — `apps/desktop/src/components/template-gallery/template-preview.tsx:387`
- **`invalidateDoc`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:111`
- **`clearDocCache`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:124`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getTemplateById` | Function | `apps/desktop/src/lib/template-registry.ts` | 3226 |
| `TemplatePreview` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 86 |
| `handleRemoveAttachment` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 387 |
| `invalidateDoc` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 111 |
| `clearDocCache` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 124 |
| `getMupdfClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 134 |
| `getTemplatePdfUrl` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 33 |
| `generateThumbnail` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 40 |
| `getCachedDocument` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 59 |
| `getOrOpenDocument` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 74 |
| `countPages` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 13 |
| `getPageSize` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 14 |
| `drawPage` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 16 |
| `closeDocument` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 12 |
| `openDocument` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 11 |
| `renderThumbnail` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 19 |
| `getAllPageSizes` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 15 |
| `ScratchForm` | Function | `apps/desktop/src/components/project-wizard.tsx` | 108 |
| `handleRemoveAttachment` | Function | `apps/desktop/src/components/project-wizard.tsx` | 196 |
| `randomProjectName` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 51 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `TemplateCard → Call` | cross_community | 5 |
| `GetOrOpenDocument → Call` | cross_community | 5 |
| `TemplatePreview → Call` | cross_community | 4 |
| `InvalidateDoc → Call` | intra_community | 4 |
| `ClearDocCache → Call` | intra_community | 4 |
| `PdfViewer → ComputeFingerprint` | cross_community | 3 |
| `TemplateCard → GetTemplatePdfUrl` | cross_community | 3 |
| `TemplateCard → OpenDocument` | cross_community | 3 |
| `TemplateCard → RenderThumbnail` | cross_community | 3 |

## How to Explore

1. `gitnexus_context({name: "getTemplateById"})` — see callers and callees
2. `gitnexus_query({query: "mupdf"})` — find related execution flows
3. Read key files listed above for implementation details
