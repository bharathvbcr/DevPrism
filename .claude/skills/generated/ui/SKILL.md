---
name: ui
description: "Skill for the Ui area of DevPrism. 68 symbols across 32 files."
---

# Ui

68 symbols | 32 files | Cohesion: 45%

## When to Use

- Working with code in `apps/`
- Understanding how DevPrismLogo, InstallProgress, CommentsPanel work
- Modifying ui-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/ui/dropdown-menu.tsx` | DropdownMenuShortcut, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem (+3) |
| `apps/desktop/src/components/ui/sheet.tsx` | SheetPortal, SheetOverlay, SheetContent, SheetHeader, SheetFooter (+2) |
| `apps/desktop/src/components/ui/card.tsx` | Card, CardHeader, CardTitle, CardDescription, CardContent (+1) |
| `apps/desktop/src/App.tsx` | LazyDebugPage, TrackChangesPdfDialog, NativeWindowThemeBridge, syncNativeTheme, App |
| `apps/desktop/src/components/ui/tabs.tsx` | Tabs, TabsList, TabsTrigger, TabsContent |
| `apps/desktop/src/components/project-picker.tsx` | SpaceGlyph, formatProjectDate, ProjectPreviewCard, SpaceNavButton |
| `apps/desktop/src/components/ui/tooltip.tsx` | TooltipProvider, Tooltip, TooltipTrigger, TooltipContent |
| `apps/desktop/src/components/workspace/space-quick-actions.tsx` | SpaceQuickActions, sendPrompt, iconFor |
| `apps/desktop/src/components/ui/scroll-area.tsx` | ScrollArea, ScrollBar |
| `apps/desktop/src/components/ui/select.tsx` | SelectScrollUpButton, SelectScrollDownButton |

## Entry Points

Start here when exploring this area:

- **`DevPrismLogo`** (Function) — `apps/desktop/src/components/devprism-logo.tsx:11`
- **`InstallProgress`** (Function) — `apps/desktop/src/components/scientific-skills/install-progress.tsx:43`
- **`CommentsPanel`** (Function) — `apps/desktop/src/components/workspace/comments-panel.tsx:91`
- **`cn`** (Function) — `apps/desktop/src/lib/utils.ts:3`
- **`ExportMenu`** (Function) — `apps/desktop/src/components/workspace/editor/export-menu.tsx:52`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `DevPrismLogo` | Function | `apps/desktop/src/components/devprism-logo.tsx` | 11 |
| `InstallProgress` | Function | `apps/desktop/src/components/scientific-skills/install-progress.tsx` | 43 |
| `CommentsPanel` | Function | `apps/desktop/src/components/workspace/comments-panel.tsx` | 91 |
| `cn` | Function | `apps/desktop/src/lib/utils.ts` | 3 |
| `ExportMenu` | Function | `apps/desktop/src/components/workspace/editor/export-menu.tsx` | 52 |
| `SpaceQuickActions` | Function | `apps/desktop/src/components/workspace/space-quick-actions.tsx` | 39 |
| `sendPrompt` | Function | `apps/desktop/src/components/workspace/space-quick-actions.tsx` | 45 |
| `iconFor` | Function | `apps/desktop/src/components/workspace/space-quick-actions.tsx` | 114 |
| `TrackChangesActions` | Function | `apps/desktop/src/components/workspace/track-changes-actions.tsx` | 40 |
| `ZoteroHeader` | Function | `apps/desktop/src/components/workspace/zotero-panel.tsx` | 171 |
| `App` | Function | `apps/desktop/src/App.tsx` | 237 |
| `BrowserPreviewBanner` | Function | `apps/desktop/src/components/browser-preview-banner.tsx` | 5 |
| `useKeyboardShortcuts` | Function | `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | 9 |
| `syncPersonalizationEnabled` | Function | `apps/desktop/src/lib/personalization.ts` | 72 |
| `setPersonalizationEnabled` | Function | `apps/desktop/src/stores/personalization-store.ts` | 111 |
| `TooltipIconButton` | Function | `apps/desktop/src/components/assistant-ui/tooltip-icon-button.tsx` | 16 |
| `Card` | Function | `apps/desktop/src/components/ui/card.tsx` | 4 |
| `CardHeader` | Function | `apps/desktop/src/components/ui/card.tsx` | 19 |
| `CardTitle` | Function | `apps/desktop/src/components/ui/card.tsx` | 31 |
| `CardDescription` | Function | `apps/desktop/src/components/ui/card.tsx` | 46 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `App → Clear` | cross_community | 6 |
| `App → IsTauri` | cross_community | 6 |
| `SpaceQuickActions → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → ResolveSemanticConfig` | cross_community | 6 |
| `SpaceQuickActions → EmbedText` | cross_community | 6 |
| `SpaceQuickActions → FormatCompressedContext` | cross_community | 6 |
| `App → IsOllamaEndpoint` | cross_community | 5 |
| `App → ResolveSemanticConfig` | cross_community | 5 |
| `SpaceQuickActions → ResolveNativeOllamaModel` | cross_community | 5 |
| `EditorToolbar → Cn` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 14 calls |
| Components | 7 calls |
| Semantic-layer | 4 calls |
| Stores | 4 calls |
| Editor | 2 calls |
| Hooks | 1 calls |
| Cluster_318 | 1 calls |

## How to Explore

1. `context({name: "DevPrismLogo"})` — see callers and callees
2. `query({search_query: "ui"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
