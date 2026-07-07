---
name: editor
description: "Skill for the Editor area of DevPrism. 230 symbols across 38 files."
---

# Editor

230 symbols | 38 files | Cohesion: 73%

## When to Use

- Working with code in `apps/`
- Understanding how aiGrammarExtension, aiPredictiveExtension, bibtex work
- Modifying editor-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | getActiveFileContent, spellCheckExtension, LatexEditor, clearJumpRequest, setIsCompiling (+42) |
| `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | OpenEditorIcon, getOpenEditorButtonClassName, FileBreadcrumb, renderCrumb, SaveStatus (+17) |
| `apps/desktop/src/lib/resume-bullets.ts` | bulletCountSuccessMessage, clampResumeBulletCount, suggestedBulletTargets, buildBulletCountInstruction, countLatexItems (+10) |
| `apps/desktop/src/components/workspace/editor/comments-extension.ts` | formatRelTime, el, dispatch, renderTooltipBody, mkBtn (+10) |
| `apps/desktop/src/lib/resume-bullet-suggestions.ts` | findSuggestionById, refinementSuccessMessage, recommendedBulletTarget, envHint, buildBulletRefinementInstruction (+6) |
| `apps/desktop/src/components/workspace/editor/editor-status-bar.tsx` | compiledPageCount, countWords, stats, selectionStats, cursorBulletBlock (+6) |
| `apps/desktop/src/components/workspace/editor/image-drop.ts` | filterImagePaths, captionAndLabel, isSvgPath, buildFigureSnippet, insertDroppedImages (+6) |
| `apps/desktop/src/lib/ai-assist.ts` | suggestCitations, extractGrammarSpan, checkGrammar, aiParseLimits, clamp (+5) |
| `apps/desktop/src/components/workspace/editor/latex-autocomplete.ts` | latexAutocomplete, fnv1a, parseSignature, getParsed, collectBibEntries (+3) |
| `apps/desktop/src/components/workspace/editor/ai-grammar-extension.ts` | aiGrammarExtension, cacheKey, grammarLinter, update, refresh (+1) |

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
| `LatexEditor` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 204 |
| `clearJumpRequest` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 215 |
| `setIsCompiling` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 217 |
| `setPdfData` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 218 |
| `setCompileError` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 219 |
| `saveAllFiles` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 220 |
| `loadFileContent` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 247 |
| `goToChunk` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 414 |
| `isOverEditor` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 1197 |
| `handleHistoryAddLabel` | Function | `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | 2264 |
| `ToolbarGroup` | Function | `apps/desktop/src/components/ui/toolbar-group.tsx` | 10 |
| `EditorToolbar` | Function | `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | 251 |
| `setVimMode` | Function | `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | 261 |
| `setSpellCheck` | Function | `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | 263 |
| `setEditorViewMode` | Function | `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | 266 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleToolbarAction → ResolveNativeOllamaModel` | cross_community | 6 |
| `HandleBulletAiSuggestion → CountLatexItems` | cross_community | 5 |
| `HandleBulletAiSuggestion → SetSelectionRange` | intra_community | 5 |
| `HandleBulletAiSuggestion → ProposeSelectionReplacement` | cross_community | 5 |
| `HandleBulletAiSuggestion → InlineEditChatPrompt` | cross_community | 5 |
| `HandleToolbarAction → IsOllamaEndpoint` | cross_community | 5 |
| `HandleToolbarAction → AcquireAiSlot` | cross_community | 5 |
| `HandleToolbarAction → ReleaseAiSlot` | cross_community | 5 |
| `ClaudeChatDrawer → GetCompileRootPreference` | cross_community | 5 |
| `DeleteFile → ParseBrowserRoot` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 50 calls |
| Ui | 17 calls |
| Cluster_345 | 5 calls |
| Preview | 5 calls |
| Browser-project | 4 calls |
| Claude-chat | 3 calls |
| Cluster_318 | 3 calls |

## How to Explore

1. `context({name: "aiGrammarExtension"})` — see callers and callees
2. `query({search_query: "editor"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
