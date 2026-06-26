---
name: ui
description: "Skill for the Ui area of DevPrism. 83 symbols across 38 files."
---

# Ui

83 symbols | 38 files | Cohesion: 80%

## When to Use

- Working with code in `apps/`
- Understanding how cn, UvSetupDialog, OllamaModelBadges work
- Modifying ui-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/ui/dropdown-menu.tsx` | DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioItem, DropdownMenuLabel (+4) |
| `apps/desktop/src/components/project-picker.tsx` | isProjectDrag, SpaceGlyph, SpaceNavButton, ProjectNavButton, SettingsDetailButton (+2) |
| `apps/desktop/src/components/ui/select.tsx` | SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator (+2) |
| `apps/desktop/src/components/workspace/sidebar.tsx` | LayoutPaneSwitcher, LayoutToggleRow, DroppableRoot, DroppableFolder, FileCommentBadge (+1) |
| `apps/desktop/src/components/ui/sheet.tsx` | SheetOverlay, SheetContent, SheetHeader, SheetFooter, SheetTitle (+1) |
| `apps/desktop/src/components/ui/dialog.tsx` | DialogOverlay, DialogContent, DialogHeader, DialogFooter, DialogTitle (+1) |
| `apps/desktop/src/components/ui/context-menu.tsx` | ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSubTrigger, ContextMenuSubContent |
| `apps/desktop/src/components/ui/tabs.tsx` | Tabs, TabsList, TabsTrigger, TabsContent |
| `apps/desktop/src/components/claude-setup.tsx` | StepRow, InstallLogOutput |
| `apps/desktop/src/components/workspace/comments-panel.tsx` | CommentsPanel, AuthorChip |

## Entry Points

Start here when exploring this area:

- **`cn`** (Function) — `apps/desktop/src/lib/utils.ts:3`
- **`UvSetupDialog`** (Function) — `apps/desktop/src/components/uv-setup.tsx:27`
- **`OllamaModelBadges`** (Function) — `apps/desktop/src/components/ollama-model-badges.tsx:9`
- **`DevPrismLogo`** (Function) — `apps/desktop/src/components/devprism-logo.tsx:11`
- **`ZoteroHeader`** (Function) — `apps/desktop/src/components/workspace/zotero-panel.tsx:152`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `cn` | Function | `apps/desktop/src/lib/utils.ts` | 3 |
| `UvSetupDialog` | Function | `apps/desktop/src/components/uv-setup.tsx` | 27 |
| `OllamaModelBadges` | Function | `apps/desktop/src/components/ollama-model-badges.tsx` | 9 |
| `DevPrismLogo` | Function | `apps/desktop/src/components/devprism-logo.tsx` | 11 |
| `ZoteroHeader` | Function | `apps/desktop/src/components/workspace/zotero-panel.tsx` | 152 |
| `HistoryPanel` | Function | `apps/desktop/src/components/workspace/history-panel.tsx` | 68 |
| `CommentsPanel` | Function | `apps/desktop/src/components/workspace/comments-panel.tsx` | 88 |
| `ToolbarGroup` | Function | `apps/desktop/src/components/ui/toolbar-group.tsx` | 10 |
| `MarkdownRenderer` | Function | `apps/desktop/src/components/claude-chat/markdown-renderer.tsx` | 78 |
| `SelectionToolbar` | Function | `apps/desktop/src/components/workspace/editor/selection-toolbar.tsx` | 31 |
| `isProjectDrag` | Function | `apps/desktop/src/components/project-picker.tsx` | 168 |
| `SpaceGlyph` | Function | `apps/desktop/src/components/project-picker.tsx` | 176 |
| `SpaceNavButton` | Function | `apps/desktop/src/components/project-picker.tsx` | 2902 |
| `ProjectNavButton` | Function | `apps/desktop/src/components/project-picker.tsx` | 2995 |
| `SettingsDetailButton` | Function | `apps/desktop/src/components/project-picker.tsx` | 3060 |
| `SettingsPanel` | Function | `apps/desktop/src/components/project-picker.tsx` | 3102 |
| `StatusRow` | Function | `apps/desktop/src/components/project-picker.tsx` | 3247 |
| `SetupItem` | Function | `apps/desktop/src/components/environment-onboarding.tsx` | 433 |
| `StepRow` | Function | `apps/desktop/src/components/claude-setup.tsx` | 417 |
| `InstallLogOutput` | Function | `apps/desktop/src/components/claude-setup.tsx` | 447 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SlashCommandPicker → Cn` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_156 | 1 calls |
| Components | 1 calls |

## How to Explore

1. `gitnexus_context({name: "cn"})` — see callers and callees
2. `gitnexus_query({query: "ui"})` — find related execution flows
3. Read key files listed above for implementation details
