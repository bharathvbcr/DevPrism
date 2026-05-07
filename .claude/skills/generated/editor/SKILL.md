---
name: editor
description: "Skill for the Editor area of devprism-main. 15 symbols across 4 files."
---

# Editor

15 symbols | 4 files | Cohesion: 91%

## When to Use

- Working with code in `apps/`
- Understanding how resetMupdfClient, bibtex, LatexEditor work
- Modifying editor-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | getActiveFileContent, LatexEditor, goToChunk, wrapSelection, afterChunkAction (+4) |
| `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | EditorToolbar, insertText, wrapSelection |
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | destroy, resetMupdfClient |
| `apps/desktop/src/components/workspace/editor/lang-bibtex.ts` | bibtex |

## Entry Points

Start here when exploring this area:

- **`resetMupdfClient`** (Function) — `apps/desktop/src/lib/mupdf/mupdf-client.ts:142`
- **`bibtex`** (Function) — `apps/desktop/src/components/workspace/editor/lang-bibtex.ts:323`
- **`LatexEditor`** (Function) — `apps/desktop/src/components/workspace/editor/latex-editor.tsx:103`
- **`goToChunk`** (Function) — `apps/desktop/src/components/workspace/editor/latex-editor.tsx:246`
- **`wrapSelection`** (Function) — `apps/desktop/src/components/workspace/editor/latex-editor.tsx:529`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `resetMupdfClient` | Function | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 142 |
| `bibtex` | Function | `apps/desktop/src/components/workspace/editor/lang-bibtex.ts` | 323 |
| `LatexEditor` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 103 |
| `goToChunk` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 246 |
| `wrapSelection` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 529 |
| `afterChunkAction` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 260 |
| `acceptCurrentChunk` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 295 |
| `rejectCurrentChunk` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 305 |
| `EditorToolbar` | Function | `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | 61 |
| `insertText` | Function | `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | 104 |
| `wrapSelection` | Function | `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | 125 |
| `destroy` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 24 |
| `getActiveFileContent` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 86 |
| `DiffLines` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 1506 |
| `computeUnifiedHunks` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 1636 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LatexEditor → ResolveTexRoot` | cross_community | 3 |
| `EditorToolbar → InsertText` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Stores | 3 calls |

## How to Explore

1. `gitnexus_context({name: "resetMupdfClient"})` — see callers and callees
2. `gitnexus_query({query: "editor"})` — find related execution flows
3. Read key files listed above for implementation details
