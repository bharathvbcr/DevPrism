---
name: workspace
description: "Skill for the Workspace area of DevPrism. 126 symbols across 23 files."
---

# Workspace

126 symbols | 23 files | Cohesion: 77%

## When to Use

- Working with code in `apps/`
- Understanding how aiComplete, checkGrammar, explainCompileErrors work
- Modifying workspace-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/sidebar.tsx` | parseTableOfContents, isInsideFolder, parentFolderOfPath, normalizeSelectionItems, useAppVersion (+18) |
| `apps/desktop/src/components/workspace/comments-panel.tsx` | handleDraftReply, CommentRow, saveEdit, cancelEdit, handleReplySubmit (+15) |
| `apps/desktop/src/lib/ai-assist.ts` | aiComplete, checkGrammar, explainCompileErrors, fetchPredictiveContinuation, fetchPredictiveActions (+8) |
| `apps/desktop/src/components/workspace/bibliography-panel.tsx` | writeBib, handleDelete, handleAddEntry, handlePasteImport, BibliographyPanel (+6) |
| `apps/desktop/src/lib/bibtex.ts` | entryToFields, removeBibEntry, appendBibEntry, importBibEntries, serializeBibEntry (+4) |
| `apps/desktop/src-tauri/src/personalization.rs` | dominant_tone, dominant_formality, top_space_kinds, top_features, top_doc_classes (+2) |
| `apps/desktop/src/components/workspace/version-overview.tsx` | formatDate, jdSnippet, VersionOverview, open_, tailorWithAi |
| `apps/desktop/src-tauri/src/latex.rs` | default, install_glyphtounicode_stub, compile_with_tectonic, test_install_glyphtounicode_stub_writes_stub, test_install_glyphtounicode_stub_does_not_clobber_project_copy |
| `apps/desktop/src/components/workspace/history-panel.tsx` | formatRelativeTime, snapshotTypeLabel, snapshotTypeBadgeColor, SnapshotRow |
| `apps/desktop/src/components/workspace/workspace-layout.tsx` | easeInOutSmooth, step, WorkspaceLayout, updateCollapsedSize |

## Entry Points

Start here when exploring this area:

- **`aiComplete`** (Function) — `apps/desktop/src/lib/ai-assist.ts:74`
- **`checkGrammar`** (Function) — `apps/desktop/src/lib/ai-assist.ts:256`
- **`explainCompileErrors`** (Function) — `apps/desktop/src/lib/ai-assist.ts:326`
- **`fetchPredictiveContinuation`** (Function) — `apps/desktop/src/lib/ai-assist.ts:424`
- **`fetchPredictiveActions`** (Function) — `apps/desktop/src/lib/ai-assist.ts:497`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `aiComplete` | Function | `apps/desktop/src/lib/ai-assist.ts` | 74 |
| `checkGrammar` | Function | `apps/desktop/src/lib/ai-assist.ts` | 256 |
| `explainCompileErrors` | Function | `apps/desktop/src/lib/ai-assist.ts` | 326 |
| `fetchPredictiveContinuation` | Function | `apps/desktop/src/lib/ai-assist.ts` | 424 |
| `fetchPredictiveActions` | Function | `apps/desktop/src/lib/ai-assist.ts` | 497 |
| `improvePrompt` | Function | `apps/desktop/src/lib/ai-assist.ts` | 520 |
| `recommendTemplates` | Function | `apps/desktop/src/lib/ai-assist.ts` | 563 |
| `summarizeDiff` | Function | `apps/desktop/src/lib/ai-assist.ts` | 648 |
| `draftCommentReply` | Function | `apps/desktop/src/lib/ai-assist.ts` | 659 |
| `suggestCitations` | Function | `apps/desktop/src/lib/ai-assist.ts` | 677 |
| `expandSearchTerms` | Function | `apps/desktop/src/lib/ai-assist.ts` | 705 |
| `handleSummarize` | Function | `apps/desktop/src/components/workspace/version-compare.tsx` | 108 |
| `SpaceQuickActions` | Function | `apps/desktop/src/components/workspace/space-quick-actions.tsx` | 38 |
| `iconFor` | Function | `apps/desktop/src/components/workspace/space-quick-actions.tsx` | 113 |
| `projectMarks` | Function | `apps/desktop/src/stores/file-marks-store.ts` | 60 |
| `Sidebar` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 564 |
| `handleAddFile` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 1515 |
| `handleCreateFolder` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 1537 |
| `handleImport` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 1551 |
| `handleProjectRename` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 1575 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DocumentOutline → IsOllamaEndpoint` | cross_community | 7 |
| `ProjectPreviewCard → IsOllamaEndpoint` | cross_community | 7 |
| `PdfViewer → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → IsOllamaEndpoint` | cross_community | 6 |
| `ChatSpaceSuggestions → IsOllamaEndpoint` | cross_community | 6 |
| `ChatFollowUpSuggestions → IsOllamaEndpoint` | cross_community | 6 |
| `EditorAiSuggestions → IsOllamaEndpoint` | cross_community | 6 |
| `DocumentOutline → ResolveNativeOllamaModel` | cross_community | 6 |
| `Inline_transform_text → Cmp` | cross_community | 6 |
| `ScratchForm → IsOllamaEndpoint` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Editor | 11 calls |
| Ui | 8 calls |
| Stores | 2 calls |
| Cluster_197 | 2 calls |
| Hooks | 2 calls |
| Cluster_156 | 1 calls |
| Cluster_179 | 1 calls |
| Claude-chat | 1 calls |

## How to Explore

1. `gitnexus_context({name: "aiComplete"})` — see callers and callees
2. `gitnexus_query({query: "workspace"})` — find related execution flows
3. Read key files listed above for implementation details
