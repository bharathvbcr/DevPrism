---
name: workspace
description: "Skill for the Workspace area of DevPrism. 228 symbols across 37 files."
---

# Workspace

228 symbols | 37 files | Cohesion: 70%

## When to Use

- Working with code in `apps/`
- Understanding how ScholarLMHeader, setOffline, BibliographyHeader work
- Modifying workspace-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/sidebar.tsx` | useAppVersion, Sidebar, setActiveFile, renameProject, importFiles (+71) |
| `apps/desktop/src/components/workspace/comments-panel.tsx` | CommentsHeader, refresh, updateComment, setActiveFile, switchToCommentFile (+21) |
| `apps/desktop/src/components/workspace/workspace-layout.tsx` | WorkspaceLayout, showWorkspaceBanner, dismissWorkspaceBanner, getCollapsedSidebarSize, animateSidebarToSize (+13) |
| `apps/desktop/src/components/workspace/history-panel.tsx` | formatRelativeTime, snapshotTypeBadgeColor, SnapshotRow, loadDiff, startReview (+8) |
| `apps/desktop/src/lib/ai-assist.ts` | isCliProviderId, throwIfAborted, resolveAiProvider, acquireAiSlot, releaseAiSlot (+5) |
| `apps/desktop/src/components/workspace/bibliography-panel.tsx` | BibliographyHeader, entries, existingKeys, count, updateFileContent (+4) |
| `apps/desktop/src/components/ui/context-menu.tsx` | ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator (+3) |
| `apps/desktop/src/components/workspace/zotero-panel.tsx` | run, ZoteroPanel, revalidate, importCollectionToBib, syncCollectionBib (+3) |
| `apps/desktop/src/components/workspace/version-switcher.tsx` | StatusDot, VersionSwitcher, sync, switchTo, setStatus (+2) |
| `apps/desktop/src/lib/bibtex.ts` | readBalancedBraces, parseFieldValue, parseBibFile, entryToFields, removeBibEntry (+2) |

## Entry Points

Start here when exploring this area:

- **`ScholarLMHeader`** (Function) — `apps/desktop/src/components/scholarlm/scholarlm-research-panel.tsx:52`
- **`setOffline`** (Function) — `apps/desktop/src/components/scholarlm/scholarlm-research-panel.tsx:54`
- **`BibliographyHeader`** (Function) — `apps/desktop/src/components/workspace/bibliography-panel.tsx:787`
- **`CommentsHeader`** (Function) — `apps/desktop/src/components/workspace/comments-panel.tsx:51`
- **`refresh`** (Function) — `apps/desktop/src/components/workspace/comments-panel.tsx:55`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ScholarLMHeader` | Function | `apps/desktop/src/components/scholarlm/scholarlm-research-panel.tsx` | 52 |
| `setOffline` | Function | `apps/desktop/src/components/scholarlm/scholarlm-research-panel.tsx` | 54 |
| `BibliographyHeader` | Function | `apps/desktop/src/components/workspace/bibliography-panel.tsx` | 787 |
| `CommentsHeader` | Function | `apps/desktop/src/components/workspace/comments-panel.tsx` | 51 |
| `refresh` | Function | `apps/desktop/src/components/workspace/comments-panel.tsx` | 55 |
| `isAgentSnapshotMessage` | Function | `apps/desktop/src/lib/chat-labels.ts` | 139 |
| `snapshotTypeLabel` | Function | `apps/desktop/src/lib/chat-labels.ts` | 157 |
| `Sidebar` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 569 |
| `setActiveFile` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 577 |
| `renameProject` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 581 |
| `importFiles` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 584 |
| `requestRevealInTree` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 592 |
| `openCareer` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 597 |
| `refreshFiles` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 598 |
| `openSection` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 722 |
| `handler` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 732 |
| `handleSlash` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 748 |
| `runRefreshFiles` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 811 |
| `refreshIfVisible` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 850 |
| `handleKeyDown` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 976 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CareerKnowledgeTab → ReadBalancedBraces` | cross_community | 6 |
| `TemplateGallery → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → AiCancelRequest` | cross_community | 6 |
| `CommentComposer → IsOllamaEndpoint` | cross_community | 6 |
| `HandleToolbarAction → IsCliProviderId` | cross_community | 6 |
| `TailorDialog → IsOllamaEndpoint` | cross_community | 6 |
| `TailorDialog → AiCancelRequest` | cross_community | 6 |
| `TemplateGallery → ThrowIfAborted` | cross_community | 5 |
| `TemplateGallery → IsCliProviderId` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Ui | 38 calls |
| Career | 32 calls |
| Editor | 8 calls |
| Claude-chat | 5 calls |
| Cluster_347 | 4 calls |
| Stores | 4 calls |
| Preview | 3 calls |
| Resume-synthesis | 3 calls |

## How to Explore

1. `context({name: "ScholarLMHeader"})` — see callers and callees
2. `query({search_query: "workspace"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
