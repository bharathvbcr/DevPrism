---
name: agent-chat
description: "Skill for the Agent-chat area of devprism-main. 28 symbols across 6 files."
---

# Agent-chat

28 symbols | 6 files | Cohesion: 93%

## When to Use

- Working with code in `apps/`
- Understanding how SlashCommandPicker, renderItem, renderEmptyState work
- Modifying agent-chat-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | scopeToTab, getCommandIcon, SlashCommandPicker, renderItem, renderEmptyState (+7) |
| `apps/desktop/src/components/agent-chat/tool-widgets.tsx` | EditWidget, BashWidget, truncate, AskUserQuestionWidget, handleOptionClick (+2) |
| `apps/desktop/src/components/agent-chat/markdown-renderer.tsx` | looksLikeShellCommand, isShellCodeBlock, CodeBlock |
| `apps/desktop/src/components/agent-chat/session-selector.tsx` | formatRelativeTime, SessionSelector |
| `apps/desktop/src/components/agent-chat/safe-mode-dialog.tsx` | SafeModeDialog, handleResponse |
| `apps/desktop/src/components/agent-chat/chat-messages.tsx` | UserMessage, renderErrorBlock |

## Entry Points

Start here when exploring this area:

- **`SlashCommandPicker`** (Function) — `apps/desktop/src/components/agent-chat/slash-command-picker.tsx:351`
- **`renderItem`** (Function) — `apps/desktop/src/components/agent-chat/slash-command-picker.tsx:520`
- **`renderEmptyState`** (Function) — `apps/desktop/src/components/agent-chat/slash-command-picker.tsx:563`
- **`renderList`** (Function) — `apps/desktop/src/components/agent-chat/slash-command-picker.tsx:600`
- **`SessionSelector`** (Function) — `apps/desktop/src/components/agent-chat/session-selector.tsx:36`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `SlashCommandPicker` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 351 |
| `renderItem` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 520 |
| `renderEmptyState` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 563 |
| `renderList` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 600 |
| `SessionSelector` | Function | `apps/desktop/src/components/agent-chat/session-selector.tsx` | 36 |
| `SafeModeDialog` | Function | `apps/desktop/src/components/agent-chat/safe-mode-dialog.tsx` | 20 |
| `handleResponse` | Function | `apps/desktop/src/components/agent-chat/safe-mode-dialog.tsx` | 36 |
| `scopeToTab` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 58 |
| `getCommandIcon` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 64 |
| `bonusFor` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 107 |
| `fuzzyScore` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 117 |
| `levenshtein` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 183 |
| `typoScore` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 210 |
| `scoreCommand` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 238 |
| `filterAndSort` | Function | `apps/desktop/src/components/agent-chat/slash-command-picker.tsx` | 260 |
| `EditWidget` | Function | `apps/desktop/src/components/agent-chat/tool-widgets.tsx` | 98 |
| `BashWidget` | Function | `apps/desktop/src/components/agent-chat/tool-widgets.tsx` | 162 |
| `truncate` | Function | `apps/desktop/src/components/agent-chat/tool-widgets.tsx` | 511 |
| `looksLikeShellCommand` | Function | `apps/desktop/src/components/agent-chat/markdown-renderer.tsx` | 32 |
| `isShellCodeBlock` | Function | `apps/desktop/src/components/agent-chat/markdown-renderer.tsx` | 64 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SlashCommandPicker → BonusFor` | cross_community | 5 |
| `SlashCommandPicker → Levenshtein` | cross_community | 5 |
| `SlashCommandPicker → Cn` | cross_community | 4 |
| `SlashCommandPicker → GetCommandIcon` | intra_community | 4 |
| `SlashCommandPicker → RenderEmptyState` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Ui | 2 calls |

## How to Explore

1. `gitnexus_context({name: "SlashCommandPicker"})` — see callers and callees
2. `gitnexus_query({query: "agent-chat"})` — find related execution flows
3. Read key files listed above for implementation details
