---
name: mupdf
description: "Skill for the Mupdf area of DevPrism. 27 symbols across 3 files."
---

# Mupdf

27 symbols | 3 files | Cohesion: 81%

## When to Use

- Working with code in `apps/`
- Understanding how handleOpenChange, getMupdfClient, invalidateDoc work
- Modifying mupdf-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | call, openDocument, closeDocument, countPages, getPageSize (+15) |
| `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | evictOldest, invalidateDoc, clearDocCache, computeFingerprint, getCachedDocument (+1) |
| `apps/desktop/src/components/template-gallery/template-preview.tsx` | handleOpenChange |

## Entry Points

Start here when exploring this area:

- **`handleOpenChange`** (Function) — `apps/desktop/src/components/template-gallery/template-preview.tsx:123`
- **`getMupdfClient`** (Function) — `apps/desktop/src/lib/mupdf/mupdf-client.ts:156`
- **`invalidateDoc`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:111`
- **`clearDocCache`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:124`
- **`getCachedDocument`** (Function) — `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts:59`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `handleOpenChange` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 123 |
| `getMupdfClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 156 |
| `invalidateDoc` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 111 |
| `clearDocCache` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 124 |
| `getCachedDocument` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 59 |
| `getOrOpenDocument` | Function | `apps/desktop/src/lib/mupdf/pdf-doc-cache.ts` | 74 |
| `resetMupdfClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 164 |
| `closeDocument` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 13 |
| `getAllPageSizes` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 16 |
| `destroy` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 32 |
| `call` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 94 |
| `openDocument` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 134 |
| `closeDocument` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 136 |
| `countPages` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 137 |
| `getPageSize` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 138 |
| `getAllPageSizes` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 139 |
| `drawPage` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 140 |
| `getPageText` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 142 |
| `getPageLinks` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 143 |
| `searchPage` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 144 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CloseProject → CreateClient` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 1 calls |
| Template-gallery | 1 calls |

## How to Explore

1. `context({name: "handleOpenChange"})` — see callers and callees
2. `query({search_query: "mupdf"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
