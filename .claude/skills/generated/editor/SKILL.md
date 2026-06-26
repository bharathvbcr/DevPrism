---
name: editor
description: "Skill for the Editor area of DevPrism. 137 symbols across 36 files."
---

# Editor

137 symbols | 36 files | Cohesion: 67%

## When to Use

- Working with code in `apps/`
- Understanding how recommendedTemplateIdsForKind, has, TemplateGallery work
- Modifying editor-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/editor/latex-editor.tsx` | DiffLines, computeUnifiedHunks, getActiveFileContent, spellCheckExtension, LatexEditor (+7) |
| `apps/desktop/src/lib/resume-bullets.ts` | bulletCountSuccessMessage, stripLatexInline, findRoleContextBefore, countLatexItems, isResumeBulletSelection (+7) |
| `apps/desktop/src/components/workspace/editor/image-drop.ts` | extOf, isDroppableImage, filterImagePaths, captionAndLabel, isSvgPath (+6) |
| `apps/desktop/src/lib/inline-edit.ts` | inlineEditUsesDirectProvider, inlineEditChatPrompt, canUseDirectInlineTransform, runInlineEdit, inlineEditUsesNativeTransform (+4) |
| `apps/desktop/src/components/workspace/editor/editor-toolbar.tsx` | getOpenEditorButtonClassName, EditorToolbar, insertText, insertSnippet, handleProfileChange (+3) |
| `apps/desktop/src/components/workspace/editor/comments-extension.ts` | formatRelTime, el, dispatch, renderTooltipBody, mkBtn (+3) |
| `apps/desktop/src/components/workspace/sidebar.tsx` | otherGroupKey, isTexFileName, buildFileTree, getOrCreateFolder, sortNodes (+1) |
| `apps/desktop/src/lib/ai-assist.ts` | canUseAiAssist, aiSuggestVersionName, extractGrammarSpan, fixLintLine, tightenToLimit (+1) |
| `apps/desktop/src/components/workspace/editor/document-outline.tsx` | readBraceArg, cleanTitle, parseOutline, DocumentOutline, jumpTo (+1) |
| `apps/desktop/src/lib/resume-bullet-suggestions.ts` | suggestionIdForInsight, findSuggestionById, refinementSuccessMessage, bulletQualityScore, bulletQualityGrade (+1) |

## Entry Points

Start here when exploring this area:

- **`recommendedTemplateIdsForKind`** (Function) — `apps/desktop/src/lib/space-features.ts:565`
- **`has`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs:40`
- **`TemplateGallery`** (Function) — `apps/desktop/src/components/template-gallery/template-gallery.tsx:32`
- **`ScientificSkillsOnboarding`** (Function) — `apps/desktop/src/components/scientific-skills/scientific-skills-onboarding.tsx:64`
- **`SessionSelector`** (Function) — `apps/desktop/src/components/claude-chat/session-selector.tsx:51`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `recommendedTemplateIdsForKind` | Function | `apps/desktop/src/lib/space-features.ts` | 565 |
| `has` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 40 |
| `TemplateGallery` | Function | `apps/desktop/src/components/template-gallery/template-gallery.tsx` | 32 |
| `ScientificSkillsOnboarding` | Function | `apps/desktop/src/components/scientific-skills/scientific-skills-onboarding.tsx` | 64 |
| `SessionSelector` | Function | `apps/desktop/src/components/claude-chat/session-selector.tsx` | 51 |
| `ChatMessages` | Function | `apps/desktop/src/components/claude-chat/chat-messages.tsx` | 231 |
| `isDroppableImage` | Function | `apps/desktop/src/components/workspace/editor/image-drop.ts` | 33 |
| `suggestVersionName` | Function | `apps/desktop/src/lib/variant-status.ts` | 31 |
| `inlineEditUsesDirectProvider` | Function | `apps/desktop/src/lib/inline-edit.ts` | 189 |
| `canUseAiAssist` | Function | `apps/desktop/src/lib/ai-assist.ts` | 56 |
| `aiSuggestVersionName` | Function | `apps/desktop/src/lib/ai-assist.ts` | 548 |
| `ProblemsPopover` | Function | `apps/desktop/src/components/workspace/editor/problems-panel.tsx` | 72 |
| `runSpanFix` | Function | `apps/desktop/src/components/workspace/editor/problems-panel.tsx` | 97 |
| `DocumentOutline` | Function | `apps/desktop/src/components/workspace/editor/document-outline.tsx` | 81 |
| `jumpTo` | Function | `apps/desktop/src/components/workspace/editor/document-outline.tsx` | 108 |
| `handleSummarize` | Function | `apps/desktop/src/components/workspace/editor/document-outline.tsx` | 123 |
| `CommentComposer` | Function | `apps/desktop/src/components/workspace/editor/comment-composer.tsx` | 27 |
| `handleAiDraft` | Function | `apps/desktop/src/components/workspace/editor/comment-composer.tsx` | 72 |
| `bulletCountSuccessMessage` | Function | `apps/desktop/src/lib/resume-bullets.ts` | 176 |
| `findRoleContextBefore` | Function | `apps/desktop/src/lib/resume-bullets.ts` | 237 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DocumentOutline → IsOllamaEndpoint` | cross_community | 7 |
| `ProjectPreviewCard → Has` | cross_community | 7 |
| `PdfViewer → Has` | cross_community | 6 |
| `DocumentOutline → ResolveNativeOllamaModel` | cross_community | 6 |
| `TemplateCard → Has` | cross_community | 6 |
| `LatexCompletionSource → IsOllamaEndpoint` | cross_community | 6 |
| `LoadProjectPreview → Has` | cross_community | 6 |
| `HandleAddressWithAi → IsOllamaEndpoint` | cross_community | 6 |
| `LatexEditor → IsSpaceKind` | cross_community | 5 |
| `EditorStatusBar → IsSpaceKind` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 7 calls |
| Ui | 7 calls |
| Hooks | 6 calls |
| Cluster_163 | 5 calls |
| Stores | 5 calls |
| Components | 3 calls |
| Claude-chat | 3 calls |
| Cluster_167 | 3 calls |

## How to Explore

1. `gitnexus_context({name: "recommendedTemplateIdsForKind"})` — see callers and callees
2. `gitnexus_query({query: "editor"})` — find related execution flows
3. Read key files listed above for implementation details
