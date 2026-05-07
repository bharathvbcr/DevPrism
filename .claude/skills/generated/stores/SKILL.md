---
name: stores
description: "Skill for the Stores area of devprism-main. 20 symbols across 5 files."
---

# Stores

20 symbols | 5 files | Cohesion: 80%

## When to Use

- Working with code in `apps/`
- Understanding how isWindowsRuntime, getPdfBytes, getCurrentPdfBytes work
- Modifying stores-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/stores/document-store.ts` | getPdfBytes, getCurrentPdfBytes, hasPdfData, resolveTexRoot, fileName (+2) |
| `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | PdfPreview, handleExport, renderContent, compile, handleCompile |
| `apps/desktop/src/lib/latex-compiler.ts` | synctexEdit, resolveCompileTarget, formatCompileError, compileLatex |
| `apps/desktop/src/stores/settings-store.ts` | isWindowsRuntime, defaultCompilerBackend, normalizeCompilerBackend |
| `apps/desktop/src/hooks/use-agent-events.ts` | handleComplete |

## Entry Points

Start here when exploring this area:

- **`isWindowsRuntime`** (Function) — `apps/desktop/src/stores/settings-store.ts:11`
- **`getPdfBytes`** (Function) — `apps/desktop/src/stores/document-store.ts:48`
- **`getCurrentPdfBytes`** (Function) — `apps/desktop/src/stores/document-store.ts:53`
- **`synctexEdit`** (Function) — `apps/desktop/src/lib/latex-compiler.ts:75`
- **`PdfPreview`** (Function) — `apps/desktop/src/components/workspace/preview/pdf-preview.tsx:88`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `isWindowsRuntime` | Function | `apps/desktop/src/stores/settings-store.ts` | 11 |
| `getPdfBytes` | Function | `apps/desktop/src/stores/document-store.ts` | 48 |
| `getCurrentPdfBytes` | Function | `apps/desktop/src/stores/document-store.ts` | 53 |
| `synctexEdit` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 75 |
| `PdfPreview` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 88 |
| `handleExport` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 469 |
| `renderContent` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 624 |
| `hasPdfData` | Function | `apps/desktop/src/stores/document-store.ts` | 60 |
| `resolveTexRoot` | Function | `apps/desktop/src/stores/document-store.ts` | 159 |
| `resolveCompileTarget` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 10 |
| `formatCompileError` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 28 |
| `compileLatex` | Function | `apps/desktop/src/lib/latex-compiler.ts` | 36 |
| `handleComplete` | Function | `apps/desktop/src/hooks/use-agent-events.ts` | 292 |
| `compile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 409 |
| `handleCompile` | Function | `apps/desktop/src/components/workspace/preview/pdf-preview.tsx` | 522 |
| `defaultCompilerBackend` | Function | `apps/desktop/src/stores/settings-store.ts` | 17 |
| `normalizeCompilerBackend` | Function | `apps/desktop/src/stores/settings-store.ts` | 21 |
| `getActiveFile` | Function | `apps/desktop/src/stores/document-store.ts` | 145 |
| `fileName` | Method | `apps/desktop/src/stores/document-store.ts` | 139 |
| `content` | Method | `apps/desktop/src/stores/document-store.ts` | 140 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `AgentChatDrawer → ResolveTexRoot` | cross_community | 5 |
| `AgentChatDrawer → CompileLatex` | cross_community | 4 |
| `AgentChatDrawer → FormatCompileError` | cross_community | 4 |
| `RenderContent → ResolveTexRoot` | cross_community | 4 |
| `LatexEditor → ResolveTexRoot` | cross_community | 3 |

## How to Explore

1. `gitnexus_context({name: "isWindowsRuntime"})` — see callers and callees
2. `gitnexus_query({query: "stores"})` — find related execution flows
3. Read key files listed above for implementation details
