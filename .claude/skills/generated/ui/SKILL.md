---
name: ui
description: "Skill for the Ui area of devprism-main. 53 symbols across 25 files."
---

# Ui

53 symbols | 25 files | Cohesion: 94%

## When to Use

- Working with code in `apps/`
- Understanding how cn, UvSetupDialog, DevPrismLogo work
- Modifying ui-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/ui/dropdown-menu.tsx` | DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioItem, DropdownMenuLabel (+4) |
| `apps/desktop/src/components/ui/select.tsx` | SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator (+2) |
| `apps/desktop/src/components/workspace/sidebar.tsx` | getFileIcon, DroppableRoot, DroppableFolder, FileTreeNode, EnvironmentSection (+1) |
| `apps/desktop/src/components/ui/dialog.tsx` | DialogOverlay, DialogContent, DialogHeader, DialogFooter, DialogTitle (+1) |
| `apps/desktop/src/components/ui/context-menu.tsx` | ContextMenuContent, ContextMenuItem, ContextMenuSeparator |
| `apps/desktop/src/components/dev-engine-setup.tsx` | StepRow, InstallLogOutput |
| `apps/desktop/src/components/ui/scroll-area.tsx` | ScrollArea, ScrollBar |
| `apps/desktop/src/lib/utils.ts` | cn |
| `apps/desktop/src/components/uv-setup.tsx` | UvSetupDialog |
| `apps/desktop/src/components/settings-dialog.tsx` | Toggle |

## Entry Points

Start here when exploring this area:

- **`cn`** (Function) — `apps/desktop/src/lib/utils.ts:3`
- **`UvSetupDialog`** (Function) — `apps/desktop/src/components/uv-setup.tsx:27`
- **`DevPrismLogo`** (Function) — `apps/desktop/src/components/devprism-logo.tsx:9`
- **`ZoteroHeader`** (Function) — `apps/desktop/src/components/workspace/zotero-panel.tsx:152`
- **`HistoryPanel`** (Function) — `apps/desktop/src/components/workspace/history-panel.tsx:80`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `cn` | Function | `apps/desktop/src/lib/utils.ts` | 3 |
| `UvSetupDialog` | Function | `apps/desktop/src/components/uv-setup.tsx` | 27 |
| `DevPrismLogo` | Function | `apps/desktop/src/components/devprism-logo.tsx` | 9 |
| `ZoteroHeader` | Function | `apps/desktop/src/components/workspace/zotero-panel.tsx` | 152 |
| `HistoryPanel` | Function | `apps/desktop/src/components/workspace/history-panel.tsx` | 80 |
| `ScientificSkillsOnboarding` | Function | `apps/desktop/src/components/scientific-skills/scientific-skills-onboarding.tsx` | 51 |
| `Toggle` | Function | `apps/desktop/src/components/settings-dialog.tsx` | 87 |
| `StatusRow` | Function | `apps/desktop/src/components/project-picker.tsx` | 353 |
| `StepRow` | Function | `apps/desktop/src/components/dev-engine-setup.tsx` | 153 |
| `InstallLogOutput` | Function | `apps/desktop/src/components/dev-engine-setup.tsx` | 183 |
| `getFileIcon` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 186 |
| `DroppableRoot` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 986 |
| `DroppableFolder` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 1008 |
| `FileTreeNode` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 1048 |
| `EnvironmentSection` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 1201 |
| `openSettings` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 1273 |
| `TooltipContent` | Function | `apps/desktop/src/components/ui/tooltip.tsx` | 34 |
| `Textarea` | Function | `apps/desktop/src/components/ui/textarea.tsx` | 4 |
| `Separator` | Function | `apps/desktop/src/components/ui/separator.tsx` | 5 |
| `SelectTrigger` | Function | `apps/desktop/src/components/ui/select.tsx` | 24 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SlashCommandPicker → Cn` | cross_community | 4 |

## How to Explore

1. `gitnexus_context({name: "cn"})` — see callers and callees
2. `gitnexus_query({query: "ui"})` — find related execution flows
3. Read key files listed above for implementation details
