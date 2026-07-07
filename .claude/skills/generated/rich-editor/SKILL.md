---
name: rich-editor
description: "Skill for the Rich-editor area of DevPrism. 22 symbols across 1 files."
---

# Rich-editor

22 symbols | 1 files | Cohesion: 94%

## When to Use

- Working with code in `apps/`
- Understanding how parseInline, flush, parseBlocks work
- Modifying rich-editor-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | readBraceGroup, readCommandName, findMatchingEnd, textNode, paragraph (+17) |

## Entry Points

Start here when exploring this area:

- **`parseInline`** (Function) — `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts:187`
- **`flush`** (Function) — `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts:191`
- **`parseBlocks`** (Function) — `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts:394`
- **`pushParagraphText`** (Function) — `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts:399`
- **`latexToRichDoc`** (Function) — `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts:538`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `parseInline` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 187 |
| `flush` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 191 |
| `parseBlocks` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 394 |
| `pushParagraphText` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 399 |
| `latexToRichDoc` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 538 |
| `escapeLatexText` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 170 |
| `serializeInline` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 581 |
| `serializeBlocks` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 646 |
| `richDocToLatex` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 690 |
| `readBraceGroup` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 86 |
| `readCommandName` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 108 |
| `findMatchingEnd` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 117 |
| `textNode` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 142 |
| `paragraph` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 148 |
| `rawBlock` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 154 |
| `unescapeText` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 159 |
| `parseListEnv` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 305 |
| `parseTabular` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 346 |
| `isBlockStart` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 384 |
| `serializeMarkedText` | Function | `apps/desktop/src/lib/rich-editor/latex-rich-doc.ts` | 569 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RichLatexEditor → UnescapeText` | cross_community | 6 |
| `RichLatexEditor → TextNode` | cross_community | 6 |
| `RichLatexEditor → ReadCommandName` | cross_community | 6 |
| `RichLatexEditor → ReadBraceGroup` | cross_community | 6 |
| `RichLatexEditor → EscapeLatexText` | cross_community | 6 |
| `RichLatexEditor → Paragraph` | cross_community | 5 |
| `RichLatexEditor → RawBlock` | cross_community | 4 |
| `RichLatexEditor → SerializeList` | cross_community | 4 |

## How to Explore

1. `context({name: "parseInline"})` — see callers and callees
2. `query({search_query: "rich-editor"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
