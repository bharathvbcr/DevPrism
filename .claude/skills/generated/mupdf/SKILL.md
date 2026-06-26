---
name: mupdf
description: "Skill for the Mupdf area of DevPrism. 13 symbols across 2 files."
---

# Mupdf

13 symbols | 2 files | Cohesion: 63%

## When to Use

- Working with code in `apps/`
- Understanding how invalidateDoc, clearDocCache, getMupdfClient work
- Modifying mupdf-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | closeDocument, createClient, call, getMupdfClient, getAllPageSizes (+2) |
| `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | evictOldest, invalidateDoc, clearDocCache, computeFingerprint, getCachedDocument (+1) |

## Entry Points

Start here when exploring this area:

- **`invalidateDoc`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:111`
- **`clearDocCache`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:124`
- **`getMupdfClient`** (Function) — `apps/desktop/src/lib/mupdf/mupdf-client.ts:156`
- **`getCachedDocument`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:59`
- **`getOrOpenDocument`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:74`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `invalidateDoc` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 111 |
| `clearDocCache` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 124 |
| `getMupdfClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 156 |
| `getCachedDocument` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 59 |
| `getOrOpenDocument` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 74 |
| `resetMupdfClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 164 |
| `closeDocument` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 13 |
| `getAllPageSizes` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 16 |
| `destroy` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 32 |
| `evictOldest` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 28 |
| `createClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 50 |
| `call` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 94 |
| `computeFingerprint` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 16 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PdfViewer → Has` | cross_community | 6 |
| `TemplateCard → Has` | cross_community | 6 |
| `TemplatePreview → Has` | cross_community | 5 |
| `HandleExport → Has` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 1 calls |
| Preview | 1 calls |
| Editor | 1 calls |

## How to Explore

1. `gitnexus_context({name: "invalidateDoc"})` — see callers and callees
2. `gitnexus_query({query: "mupdf"})` — find related execution flows
3. Read key files listed above for implementation details
