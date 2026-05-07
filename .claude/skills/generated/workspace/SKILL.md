---
name: workspace
description: "Skill for the Workspace area of devprism-main. 19 symbols across 3 files."
---

# Workspace

19 symbols | 3 files | Cohesion: 95%

## When to Use

- Working with code in `apps/`
- Understanding how Sidebar, handleAddFile, handleCreateFolder work
- Modifying workspace-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/workspace/sidebar.tsx` | parseTableOfContents, buildFileTree, getOrCreateFolder, sortNodes, useAppVersion (+7) |
| `apps/desktop/src/components/workspace/history-panel.tsx` | formatRelativeTime, isAgentSnapshot, snapshotTypeLabel, snapshotTypeBadgeColor, SnapshotRow |
| `apps/desktop/src/components/workspace/zotero-panel.tsx` | ZoteroApiKeyDialog, handleConnect |

## Entry Points

Start here when exploring this area:

- **`Sidebar`** (Function) — `apps/desktop/src/components/workspace/sidebar.tsx:212`
- **`handleAddFile`** (Function) — `apps/desktop/src/components/workspace/sidebar.tsx:511`
- **`handleCreateFolder`** (Function) — `apps/desktop/src/components/workspace/sidebar.tsx:533`
- **`handleImport`** (Function) — `apps/desktop/src/components/workspace/sidebar.tsx:547`
- **`handleRename`** (Function) — `apps/desktop/src/components/workspace/sidebar.tsx:586`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `Sidebar` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 212 |
| `handleAddFile` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 511 |
| `handleCreateFolder` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 533 |
| `handleImport` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 547 |
| `handleRename` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 586 |
| `openNewFileDialog` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 608 |
| `openNewFolderDialog` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 615 |
| `parseTableOfContents` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 89 |
| `buildFileTree` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 125 |
| `getOrCreateFolder` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 129 |
| `sortNodes` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 170 |
| `useAppVersion` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 202 |
| `formatRelativeTime` | Function | `apps/desktop/src/components/workspace/history-panel.tsx` | 32 |
| `isAgentSnapshot` | Function | `apps/desktop/src/components/workspace/history-panel.tsx` | 48 |
| `snapshotTypeLabel` | Function | `apps/desktop/src/components/workspace/history-panel.tsx` | 55 |
| `snapshotTypeBadgeColor` | Function | `apps/desktop/src/components/workspace/history-panel.tsx` | 66 |
| `SnapshotRow` | Function | `apps/desktop/src/components/workspace/history-panel.tsx` | 283 |
| `ZoteroApiKeyDialog` | Function | `apps/desktop/src/components/workspace/zotero-panel.tsx` | 355 |
| `handleConnect` | Function | `apps/desktop/src/components/workspace/zotero-panel.tsx` | 367 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Sidebar → GetOrCreateFolder` | intra_community | 3 |
| `Sidebar → SortNodes` | intra_community | 3 |
| `SnapshotRow → IsAgentSnapshot` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Tools | 1 calls |
| Ui | 1 calls |

## How to Explore

1. `gitnexus_context({name: "Sidebar"})` — see callers and callees
2. `gitnexus_query({query: "workspace"})` — find related execution flows
3. Read key files listed above for implementation details
