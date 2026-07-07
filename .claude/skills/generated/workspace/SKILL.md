---
name: workspace
description: "Skill for the Workspace area of DevPrism. 384 symbols across 73 files."
---

# Workspace

384 symbols | 73 files | Cohesion: 68%

## When to Use

- Working with code in `apps/`
- Understanding how stats, SessionSelector, newSession work
- Modifying workspace-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/sidebar.tsx` | EnvironmentSection, checkSkillsStatus, DevPrismSkillsDialog, handleInstallBundled, handleCreate (+78) |
| `apps/desktop/src/components/workspace/comments-panel.tsx` | CommentsHeader, refresh, updateComment, setActiveFile, switchToCommentFile (+23) |
| `apps/desktop/src/components/workspace/history-panel.tsx` | HistoryPanel, init, loadDiff, startReview, addLabel (+15) |
| `apps/desktop/src/components/workspace/workspace-layout.tsx` | WorkspaceLayout, showWorkspaceBanner, dismissWorkspaceBanner, getCollapsedSidebarSize, animateSidebarToSize (+13) |
| `apps/desktop/src/components/workspace/bibliography-panel.tsx` | BibliographyPanel, setActiveFile, handleSaveEntry, handleCopyCite, handleAiGenerate (+11) |
| `apps/desktop/src/components/workspace/version-switcher.tsx` | countTargetWords, TargetDescriptionTextarea, setJd, TailorDialog, submit (+10) |
| `apps/desktop/src/components/workspace/editor/rich/rich-latex-editor.tsx` | lineToOffset, getGrammarCheckSpan, RichLatexEditor, setViewMode, requestJumpToPosition (+9) |
| `apps/desktop/src/lib/ai-assist.ts` | canUseAiAssist, completeBibEntryFields, summarizeSection, draftCommentSuggestion, parseJsonObject (+8) |
| `apps/desktop/src/components/workspace/zotero-panel.tsx` | SuggestCollection, ZoteroApiKeyDialog, connect, handleConnect, run (+7) |
| `apps/desktop/src/components/workspace/version-overview.tsx` | formatDate, jdSnippet, VersionOverview, setStatus, DeleteDialog (+5) |

## Entry Points

Start here when exploring this area:

- **`stats`** (Function) — `apps/desktop/src/components/claude-chat/proposed-changes-panel.tsx:159`
- **`SessionSelector`** (Function) — `apps/desktop/src/components/claude-chat/session-selector.tsx:51`
- **`newSession`** (Function) — `apps/desktop/src/components/claude-chat/session-selector.tsx:61`
- **`resumeSession`** (Function) — `apps/desktop/src/components/claude-chat/session-selector.tsx:62`
- **`handleSelectSession`** (Function) — `apps/desktop/src/components/claude-chat/session-selector.tsx:111`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `stats` | Function | `apps/desktop/src/components/claude-chat/proposed-changes-panel.tsx` | 159 |
| `SessionSelector` | Function | `apps/desktop/src/components/claude-chat/session-selector.tsx` | 51 |
| `newSession` | Function | `apps/desktop/src/components/claude-chat/session-selector.tsx` | 61 |
| `resumeSession` | Function | `apps/desktop/src/components/claude-chat/session-selector.tsx` | 62 |
| `handleSelectSession` | Function | `apps/desktop/src/components/claude-chat/session-selector.tsx` | 111 |
| `handleDeleteSession` | Function | `apps/desktop/src/components/claude-chat/session-selector.tsx` | 121 |
| `handleNewChat` | Function | `apps/desktop/src/components/claude-chat/session-selector.tsx` | 152 |
| `SlashCommandPicker` | Function | `apps/desktop/src/components/claude-chat/slash-command-picker.tsx` | 364 |
| `selectProviderCard` | Function | `apps/desktop/src/components/claude-setup.tsx` | 645 |
| `renderApiKeyForm` | Function | `apps/desktop/src/components/claude-setup.tsx` | 689 |
| `ErrorFallback` | Function | `apps/desktop/src/components/error-fallback.tsx` | 4 |
| `PersonalizationSettings` | Function | `apps/desktop/src/components/personalization-settings.tsx` | 32 |
| `toggleSection` | Function | `apps/desktop/src/components/personalization-settings.tsx` | 61 |
| `handleAddInterest` | Function | `apps/desktop/src/components/personalization-settings.tsx` | 93 |
| `sectionMatches` | Function | `apps/desktop/src/components/personalization-settings.tsx` | 105 |
| `ScientificSkillsOnboarding` | Function | `apps/desktop/src/components/scientific-skills/scientific-skills-onboarding.tsx` | 64 |
| `TemplatePreview` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 69 |
| `handleRemoveAttachment` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 421 |
| `InlineBanner` | Function | `apps/desktop/src/components/ui/inline-banner.tsx` | 29 |
| `UvSetupDialog` | Function | `apps/desktop/src/components/uv-setup.tsx` | 27 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RenderApiKeyForm → DeepseekOrigin` | cross_community | 7 |
| `RenderApiKeyForm → QwenOrigin` | cross_community | 7 |
| `RenderApiKeyForm → NormalizeOriginOnlyUrl` | cross_community | 7 |
| `RenderApiKeyForm → MoonshotOrigin` | cross_community | 7 |
| `TailorDialog → IsTauri` | cross_community | 7 |
| `RichLatexEditor → UnescapeText` | cross_community | 6 |
| `RichLatexEditor → TextNode` | cross_community | 6 |
| `RichLatexEditor → ReadCommandName` | cross_community | 6 |
| `RichLatexEditor → ReadBraceGroup` | cross_community | 6 |
| `RichLatexEditor → EscapeLatexText` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Ui | 84 calls |
| Components | 17 calls |
| Preview | 14 calls |
| Editor | 13 calls |
| Mupdf | 5 calls |
| Browser-project | 5 calls |
| Claude-chat | 5 calls |
| Cluster_332 | 4 calls |

## How to Explore

1. `context({name: "stats"})` — see callers and callees
2. `query({search_query: "workspace"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
