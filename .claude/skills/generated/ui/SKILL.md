---
name: ui
description: "Skill for the Ui area of DevPrism. 60 symbols across 27 files."
---

# Ui

60 symbols | 27 files | Cohesion: 42%

## When to Use

- Working with code in `apps/`
- Understanding how DevPrismLogo, cn, ExportMenu work
- Modifying ui-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/ui/dropdown-menu.tsx` | DropdownMenuShortcut, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem (+3) |
| `apps/desktop/src/components/ui/sheet.tsx` | SheetPortal, SheetOverlay, SheetContent, SheetHeader, SheetFooter (+2) |
| `apps/desktop/src/components/ui/card.tsx` | Card, CardHeader, CardTitle, CardDescription, CardContent (+1) |
| `apps/desktop/src/App.tsx` | LazyDebugPage, CareerView, TrackChangesPdfDialog, NativeWindowThemeBridge, syncNativeTheme (+1) |
| `apps/desktop/src/components/project-picker.tsx` | SpaceGlyph, formatProjectDate, ProjectPreviewCard, SpaceNavButton |
| `apps/desktop/src/components/ui/tooltip.tsx` | TooltipProvider, Tooltip, TooltipTrigger, TooltipContent |
| `apps/desktop/src/components/workspace/space-quick-actions.tsx` | SpaceQuickActions, sendPrompt, iconFor |
| `apps/desktop/src/components/ui/select.tsx` | SelectScrollUpButton, SelectScrollDownButton |
| `apps/desktop/src/components/workspace/sidebar.tsx` | LayoutPaneSwitcher, LayoutToggleRow |
| `apps/desktop/src/components/devprism-logo.tsx` | DevPrismLogo |

## Entry Points

Start here when exploring this area:

- **`DevPrismLogo`** (Function) — `apps/desktop/src/components/devprism-logo.tsx:11`
- **`cn`** (Function) — `apps/desktop/src/lib/utils.ts:3`
- **`ExportMenu`** (Function) — `apps/desktop/src/components/workspace/editor/export-menu.tsx:52`
- **`SpaceQuickActions`** (Function) — `apps/desktop/src/components/workspace/space-quick-actions.tsx:39`
- **`sendPrompt`** (Function) — `apps/desktop/src/components/workspace/space-quick-actions.tsx:45`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `DevPrismLogo` | Function | `apps/desktop/src/components/devprism-logo.tsx` | 11 |
| `cn` | Function | `apps/desktop/src/lib/utils.ts` | 3 |
| `ExportMenu` | Function | `apps/desktop/src/components/workspace/editor/export-menu.tsx` | 52 |
| `SpaceQuickActions` | Function | `apps/desktop/src/components/workspace/space-quick-actions.tsx` | 39 |
| `sendPrompt` | Function | `apps/desktop/src/components/workspace/space-quick-actions.tsx` | 45 |
| `iconFor` | Function | `apps/desktop/src/components/workspace/space-quick-actions.tsx` | 114 |
| `TrackChangesActions` | Function | `apps/desktop/src/components/workspace/track-changes-actions.tsx` | 40 |
| `ZoteroHeader` | Function | `apps/desktop/src/components/workspace/zotero-panel.tsx` | 171 |
| `App` | Function | `apps/desktop/src/App.tsx` | 244 |
| `BrowserPreviewBanner` | Function | `apps/desktop/src/components/browser-preview-banner.tsx` | 5 |
| `useKeyboardShortcuts` | Function | `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | 9 |
| `syncPersonalizationEnabled` | Function | `apps/desktop/src/lib/personalization.ts` | 72 |
| `setPersonalizationEnabled` | Function | `apps/desktop/src/stores/personalization-store.ts` | 111 |
| `TooltipIconButton` | Function | `apps/desktop/src/components/assistant-ui/tooltip-icon-button.tsx` | 16 |
| `Card` | Function | `apps/desktop/src/components/ui/card.tsx` | 4 |
| `CardHeader` | Function | `apps/desktop/src/components/ui/card.tsx` | 19 |
| `CardTitle` | Function | `apps/desktop/src/components/ui/card.tsx` | 31 |
| `CardDescription` | Function | `apps/desktop/src/components/ui/card.tsx` | 46 |
| `CardContent` | Function | `apps/desktop/src/components/ui/card.tsx` | 58 |
| `CardFooter` | Function | `apps/desktop/src/components/ui/card.tsx` | 66 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SpaceQuickActions → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → AiCancelRequest` | cross_community | 6 |
| `SpaceQuickActions → IsCliProviderId` | cross_community | 5 |
| `SpaceQuickActions → ResolveNativeOllamaModel` | cross_community | 5 |
| `EditorToolbar → Cn` | cross_community | 4 |
| `CareerView → Cn` | cross_community | 4 |
| `ScientificSkillsOnboarding → Cn` | cross_community | 4 |
| `BibliographyPanel → Cn` | cross_community | 4 |
| `VersionOverview → Cn` | cross_community | 4 |
| `BlockEditor → Cn` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Career | 9 calls |
| Components | 7 calls |
| Semantic-layer | 4 calls |
| Stores | 4 calls |
| Workspace | 4 calls |
| Editor | 2 calls |
| Browser-project | 1 calls |
| Hooks | 1 calls |

## How to Explore

1. `context({name: "DevPrismLogo"})` — see callers and callees
2. `query({search_query: "ui"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
