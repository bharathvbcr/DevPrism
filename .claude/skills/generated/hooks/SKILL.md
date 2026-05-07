---
name: hooks
description: "Skill for the Hooks area of devprism-main. 23 symbols across 7 files."
---

# Hooks

23 symbols | 7 files | Cohesion: 96%

## When to Use

- Working with code in `apps/`
- Understanding how clampAppZoom, readStoredAppZoom, persistAppZoom work
- Modifying hooks-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/app-zoom.ts` | roundZoom, clampAppZoom, readStoredAppZoom, applyAppZoom, persistAppZoom (+6) |
| `apps/desktop/src/hooks/use-agent-events.ts` | useAgentEvents, registerProposedChange, elapsed, handleStreamMessage |
| `apps/desktop/src/main.tsx` | hideLoadingScreen, bootstrap |
| `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | handleZoomKeyDown, useKeyboardShortcuts |
| `apps/desktop/src/components/agent-chat/agent-chat-drawer.tsx` | AgentChatDrawer, panelStyle |
| `apps/desktop/src/lib/tauri/fs.ts` | readTexFileContent |
| `apps/desktop/src/App.tsx` | App |

## Entry Points

Start here when exploring this area:

- **`clampAppZoom`** (Function) — `apps/desktop/src/lib/app-zoom.ts:20`
- **`readStoredAppZoom`** (Function) — `apps/desktop/src/lib/app-zoom.ts:24`
- **`persistAppZoom`** (Function) — `apps/desktop/src/lib/app-zoom.ts:40`
- **`initializeAppZoom`** (Function) — `apps/desktop/src/lib/app-zoom.ts:46`
- **`zoomInApp`** (Function) — `apps/desktop/src/lib/app-zoom.ts:50`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `clampAppZoom` | Function | `apps/desktop/src/lib/app-zoom.ts` | 20 |
| `readStoredAppZoom` | Function | `apps/desktop/src/lib/app-zoom.ts` | 24 |
| `persistAppZoom` | Function | `apps/desktop/src/lib/app-zoom.ts` | 40 |
| `initializeAppZoom` | Function | `apps/desktop/src/lib/app-zoom.ts` | 46 |
| `zoomInApp` | Function | `apps/desktop/src/lib/app-zoom.ts` | 50 |
| `zoomOutApp` | Function | `apps/desktop/src/lib/app-zoom.ts` | 54 |
| `resetAppZoom` | Function | `apps/desktop/src/lib/app-zoom.ts` | 58 |
| `getAppZoomAction` | Function | `apps/desktop/src/lib/app-zoom.ts` | 62 |
| `shouldHandleAppZoomShortcut` | Function | `apps/desktop/src/lib/app-zoom.ts` | 98 |
| `handleZoomKeyDown` | Function | `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | 13 |
| `useAgentEvents` | Function | `apps/desktop/src/hooks/use-agent-events.ts` | 51 |
| `registerProposedChange` | Function | `apps/desktop/src/hooks/use-agent-events.ts` | 87 |
| `elapsed` | Function | `apps/desktop/src/hooks/use-agent-events.ts` | 121 |
| `handleStreamMessage` | Function | `apps/desktop/src/hooks/use-agent-events.ts` | 127 |
| `readTexFileContent` | Function | `apps/desktop/src/lib/tauri/fs.ts` | 206 |
| `AgentChatDrawer` | Function | `apps/desktop/src/components/agent-chat/agent-chat-drawer.tsx` | 18 |
| `panelStyle` | Function | `apps/desktop/src/components/agent-chat/agent-chat-drawer.tsx` | 102 |
| `App` | Function | `apps/desktop/src/App.tsx` | 112 |
| `useKeyboardShortcuts` | Function | `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` | 11 |
| `hideLoadingScreen` | Function | `apps/desktop/src/main.tsx` | 56 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleZoomKeyDown → RoundZoom` | intra_community | 6 |
| `AgentChatDrawer → ReadTexFileContent` | intra_community | 5 |
| `AgentChatDrawer → ResolveTexRoot` | cross_community | 5 |
| `Bootstrap → RoundZoom` | intra_community | 5 |
| `AgentChatDrawer → Elapsed` | intra_community | 4 |
| `AgentChatDrawer → CompileLatex` | cross_community | 4 |
| `AgentChatDrawer → FormatCompileError` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Stores | 1 calls |
| Ui | 1 calls |

## How to Explore

1. `gitnexus_context({name: "clampAppZoom"})` — see callers and callees
2. `gitnexus_query({query: "hooks"})` — find related execution flows
3. Read key files listed above for implementation details
