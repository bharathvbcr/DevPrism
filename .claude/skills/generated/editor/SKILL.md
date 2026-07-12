---
name: editor
description: "Skill for the Editor area of DevPrism. 247 symbols across 44 files."
---

# Editor

247 symbols | 44 files | Cohesion: 71%

## When to Use

- Working with code in `apps/`
- Understanding how aiGrammarExtension, aiPredictiveExtension, bibtex work
- Modifying editor-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | getActiveFileContent, spellCheckExtension, LatexEditor, clearJumpRequest, setIsCompiling (+45) |
| `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | OpenEditorIcon, getOpenEditorButtonClassName, FileBreadcrumb, renderCrumb, SaveStatus (+17) |
| `apps/desktop/src/lib/resume-bullets.ts` | bulletCountSuccessMessage, clampResumeBulletCount, suggestedBulletTargets, buildBulletCountInstruction, countLatexItems (+10) |
| `apps/desktop/src/components/workspace/editor/comments-extension.ts` | formatRelTime, el, dispatch, renderTooltipBody, mkBtn (+10) |
| `apps/desktop/src/lib/resume-bullet-suggestions.ts` | findSuggestionById, refinementSuccessMessage, recommendedBulletTarget, envHint, buildBulletRefinementInstruction (+6) |
| `apps/desktop/src/components/workspace/editor/editor-status-bar.tsx` | compiledPageCount, countWords, stats, selectionStats, cursorBulletBlock (+6) |
| `apps/desktop/src/lib/ai-assist.ts` | extractGrammarSpan, checkGrammar, suggestCitations, draftCommentReply, aiParseLimits (+6) |
| `apps/desktop/src/components/workspace/editor/image-drop.ts` | filterImagePaths, captionAndLabel, isSvgPath, buildFigureSnippet, insertDroppedImages (+6) |
| `apps/desktop/src/components/workspace/editor/latex-autocomplete.ts` | latexAutocomplete, fnv1a, parseSignature, getParsed, collectBibEntries (+3) |
| `apps/desktop/src/lib/inline-edit.ts` | canUseDirectInlineTransform, runInlineEdit, inlineEditUsesNativeTransform, inlineEditSuccessMessage, applyLintLineFix (+2) |

## Entry Points

Start here when exploring this area:

- **`aiGrammarExtension`** (Function) — `apps/desktop/src/components/workspace/editor/ai-grammar-extension.ts:23`
- **`aiPredictiveExtension`** (Function) — `apps/desktop/src/components/workspace/editor/ai-predictive-extension.ts:152`
- **`bibtex`** (Function) — `apps/desktop/src/components/workspace/editor/lang-bibtex.ts:323`
- **`latexAutocomplete`** (Function) — `apps/desktop/src/components/workspace/editor/latex-autocomplete.ts:240`
- **`latexStyling`** (Function) — `apps/desktop/src/components/workspace/editor/latex-styling-extension.ts:84`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `aiGrammarExtension` | Function | `apps/desktop/src/components/workspace/editor/ai-grammar-extension.ts` | 23 |
| `aiPredictiveExtension` | Function | `apps/desktop/src/components/workspace/editor/ai-predictive-extension.ts` | 152 |
| `bibtex` | Function | `apps/desktop/src/components/workspace/editor/lang-bibtex.ts` | 323 |
| `latexAutocomplete` | Function | `apps/desktop/src/components/workspace/editor/latex-autocomplete.ts` | 240 |
| `latexStyling` | Function | `apps/desktop/src/components/workspace/editor/latex-styling-extension.ts` | 84 |
| `LatexEditor` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 203 |
| `clearJumpRequest` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 214 |
| `setIsCompiling` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 216 |
| `setPdfData` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 217 |
| `setCompileError` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 218 |
| `saveAllFiles` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 219 |
| `loadFileContent` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 246 |
| `goToChunk` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 413 |
| `isOverEditor` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 1196 |
| `handleHistoryAddLabel` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 2263 |
| `setSelectionRange` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 212 |
| `buildSelectionContext` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 1587 |
| `buildInlineEditSelection` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 1603 |
| `dismissSelectionToolbar` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 1684 |
| `runSelectionInlineEdit` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 1690 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleToolbarAction → IsCliProviderId` | cross_community | 6 |
| `HandleBulletAiSuggestion → CountLatexItems` | cross_community | 5 |
| `HandleBulletAiSuggestion → SetSelectionRange` | intra_community | 5 |
| `HandleBulletAiSuggestion → ProposeSelectionReplacement` | cross_community | 5 |
| `HandleBulletAiSuggestion → InlineEditChatPrompt` | cross_community | 5 |
| `HandleToolbarAction → IsOllamaEndpoint` | cross_community | 5 |
| `HandleToolbarAction → ThrowIfAborted` | cross_community | 5 |
| `HandleToolbarAction → NewAiRequestId` | cross_community | 5 |
| `LatexEditor → ResolveTexRoot` | cross_community | 4 |
| `EditorToolbar → IsOllamaEndpoint` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Career | 32 calls |
| Ui | 17 calls |
| Workspace | 13 calls |
| Preview | 6 calls |
| Cluster_362 | 5 calls |
| Stores | 4 calls |
| Browser-project | 4 calls |
| Cluster_320 | 3 calls |

## How to Explore

1. `context({name: "aiGrammarExtension"})` — see callers and callees
2. `query({search_query: "editor"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
