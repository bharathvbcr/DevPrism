---
name: claude-chat
description: "Skill for the Claude-chat area of DevPrism. 60 symbols across 16 files."
---

# Claude-chat

60 symbols | 16 files | Cohesion: 77%

## When to Use

- Working with code in `apps/`
- Understanding how offsetToLineCol, useOllamaStatus, getOllamaStatus work
- Modifying claude-chat-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/claude-chat/chat-composer.tsx` | pastedFileExtension, safePastedFileName, readFileAsDataUrl, temporaryFilePaths, cleanupTemporaryFilePaths (+13) |
| `apps/desktop/src/components/claude-chat/slash-command-picker.tsx` | scopeToTab, getCommandIcon, SlashCommandPicker, renderItem, renderEmptyState (+7) |
| `apps/desktop/src/components/claude-chat/tool-widgets.tsx` | EditWidget, BashWidget, truncate, AskUserQuestionWidget, handleOptionClick (+4) |
| `apps/desktop/src/lib/ollama.ts` | getOllamaStatus, ollamaModelHeuristics, formatOllamaModelSize |
| `apps/desktop/src/components/claude-chat/chat-messages.tsx` | UserMessage, renderErrorBlock, submitEdit |
| `apps/desktop/src/lib/ai-assist.ts` | fetchContextSuggestions, fetchChatFollowUps |
| `apps/desktop/src/components/claude-chat/chat-space-suggestions.tsx` | ChatSpaceSuggestions, runPrompt |
| `apps/desktop/src/components/claude-chat/chat-follow-up-suggestions.tsx` | extractLastAssistantText, ChatFollowUpSuggestions |
| `apps/desktop/src/components/claude-chat/proposed-changes-panel.tsx` | ProposedChangesPanel, updateWidth |
| `apps/desktop/src/stores/claude-chat-store.ts` | offsetToLineCol |

## Entry Points

Start here when exploring this area:

- **`offsetToLineCol`** (Function) — `apps/desktop/src/stores/claude-chat-store.ts:49`
- **`useOllamaStatus`** (Function) — `apps/desktop/src/hooks/use-ollama-status.ts:6`
- **`getOllamaStatus`** (Function) — `apps/desktop/src/lib/ollama.ts:68`
- **`ollamaModelHeuristics`** (Function) — `apps/desktop/src/lib/ollama.ts:87`
- **`formatOllamaModelSize`** (Function) — `apps/desktop/src/lib/ollama.ts:100`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `offsetToLineCol` | Function | `apps/desktop/src/stores/claude-chat-store.ts` | 49 |
| `useOllamaStatus` | Function | `apps/desktop/src/hooks/use-ollama-status.ts` | 6 |
| `getOllamaStatus` | Function | `apps/desktop/src/lib/ollama.ts` | 68 |
| `ollamaModelHeuristics` | Function | `apps/desktop/src/lib/ollama.ts` | 87 |
| `formatOllamaModelSize` | Function | `apps/desktop/src/lib/ollama.ts` | 100 |
| `ChatComposer` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 283 |
| `selectCredential` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1849 |
| `deriveOwner` | Function | `apps/desktop/src/stores/variants-store.ts` | 28 |
| `useSpaceFeatures` | Function | `apps/desktop/src/hooks/use-space-features.ts` | 26 |
| `recordPersonalizationEvent` | Function | `apps/desktop/src/lib/personalization.ts` | 34 |
| `fetchContextSuggestions` | Function | `apps/desktop/src/lib/ai-assist.ts` | 274 |
| `fetchChatFollowUps` | Function | `apps/desktop/src/lib/ai-assist.ts` | 296 |
| `SpaceFeaturesBar` | Function | `apps/desktop/src/components/workspace/space-features-bar.tsx` | 13 |
| `ChatSpaceSuggestions` | Function | `apps/desktop/src/components/claude-chat/chat-space-suggestions.tsx` | 15 |
| `runPrompt` | Function | `apps/desktop/src/components/claude-chat/chat-space-suggestions.tsx` | 81 |
| `ChatFollowUpSuggestions` | Function | `apps/desktop/src/components/claude-chat/chat-follow-up-suggestions.tsx` | 32 |
| `EditorAiSuggestions` | Function | `apps/desktop/src/components/workspace/editor/editor-ai-suggestions.tsx` | 15 |
| `SlashCommandPicker` | Function | `apps/desktop/src/components/claude-chat/slash-command-picker.tsx` | 351 |
| `renderItem` | Function | `apps/desktop/src/components/claude-chat/slash-command-picker.tsx` | 520 |
| `renderEmptyState` | Function | `apps/desktop/src/components/claude-chat/slash-command-picker.tsx` | 563 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ChatSpaceSuggestions → IsOllamaEndpoint` | cross_community | 6 |
| `ChatFollowUpSuggestions → IsOllamaEndpoint` | cross_community | 6 |
| `EditorAiSuggestions → IsOllamaEndpoint` | cross_community | 6 |
| `LatexEditor → IsSpaceKind` | cross_community | 5 |
| `EditorStatusBar → IsSpaceKind` | cross_community | 5 |
| `EditorToolbar → IsSpaceKind` | cross_community | 5 |
| `SpaceQuickActions → IsSpaceKind` | cross_community | 5 |
| `ChatSpaceSuggestions → IsSpaceKind` | cross_community | 5 |
| `ChatSpaceSuggestions → ResolveNativeOllamaModel` | cross_community | 5 |
| `ChatFollowUpSuggestions → IsSpaceKind` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 8 calls |
| Ui | 7 calls |
| Editor | 7 calls |
| Components | 4 calls |
| Cluster_156 | 2 calls |
| Cluster_179 | 2 calls |
| Cluster_168 | 2 calls |
| Stores | 1 calls |

## How to Explore

1. `gitnexus_context({name: "offsetToLineCol"})` — see callers and callees
2. `gitnexus_query({query: "claude-chat"})` — find related execution flows
3. Read key files listed above for implementation details
