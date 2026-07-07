---
name: claude-chat
description: "Skill for the Claude-chat area of DevPrism. 184 symbols across 26 files."
---

# Claude-chat

184 symbols | 26 files | Cohesion: 76%

## When to Use

- Working with code in `apps/`
- Understanding how ChatComposer, cancelExecution, setSelectedModel work
- Modifying claude-chat-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/claude-chat/chat-composer.tsx` | cleanupTemporaryFilePaths, cleanupTemporaryPinnedContext, getFileIcon, formatGuidanceText, effortShortLabel (+44) |
| `apps/desktop/src/components/claude-chat/tool-widgets.tsx` | ToolWidget, StatusIcon, DisclosureChevron, ToolRowButton, WriteWidget (+19) |
| `apps/desktop/src/components/claude-chat/chat-messages.tsx` | MessageActions, RegenerateButton, resendFromMessage, SummaryCallout, MessageBubble (+13) |
| `apps/desktop/src/components/claude-chat/slash-command-picker.tsx` | scopeToTab, filterAndSort, tabCounts, filtered, searchGroups (+9) |
| `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx` | ClaudeChatDrawer, openDrawer, onOpen, panelStyle, restoreFocus (+6) |
| `apps/desktop/src/components/claude-chat/markdown-renderer.tsx` | MarkdownRenderer, looksLikeShellCommand, isShellCodeBlock, code, CodeBlock (+3) |
| `apps/desktop/src/components/claude-chat/chat-tab-bar.tsx` | ChatTabBar, setActiveTab, closeTab, handleKeyDown, handleClose (+3) |
| `apps/desktop/src/components/claude-chat/context-usage-indicator.tsx` | ContextUsageIndicator, latestContextTruncation, truncation, latestPromptTokens, promptTokens (+2) |
| `apps/desktop/src/components/claude-chat/proposed-changes-panel.tsx` | rawDiff, diffRows, DiffLinePrefix, UnifiedDiffView, SplitDiffView (+2) |
| `apps/desktop/src/lib/model-capabilities.ts` | rememberModelCapabilityMetadata, rememberModelListCapabilityMetadata, modelInfoId, isChatModelOption |

## Entry Points

Start here when exploring this area:

- **`ChatComposer`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:291`
- **`cancelExecution`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:295`
- **`setSelectedModel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:304`
- **`setSelectedProviderModel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:314`
- **`setEffortLevel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:318`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ChatComposer` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 291 |
| `cancelExecution` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 295 |
| `setSelectedModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 304 |
| `setSelectedProviderModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 314 |
| `setEffortLevel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 318 |
| `setNativeOllamaModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 362 |
| `loadOllamaModels` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 728 |
| `refreshOllamaModels` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 747 |
| `importFiles` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 836 |
| `consumePendingAttachments` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 842 |
| `consumePendingPinnedContextRemovals` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 848 |
| `consumePendingComposerInput` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 890 |
| `buildPinnedContextForFile` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 979 |
| `selectMention` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 998 |
| `clearComposerInput` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1077 |
| `dismissGhostText` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1091 |
| `acceptGhostText` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1219 |
| `handleImprovePrompt` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1236 |
| `handleKeyDown` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1583 |
| `ContextUsageIndicator` | Function | `apps/desktop/src/components/claude-chat/context-usage-indicator.tsx` | 88 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandlePaste → ParseBrowserRoot` | cross_community | 6 |
| `HandlePaste → BrowserRootPath` | cross_community | 6 |
| `HandlePaste → RelativeFromBrowserAbsolute` | cross_community | 6 |
| `SpaceQuickActions → IsOllamaEndpoint` | cross_community | 6 |
| `CommentComposer → IsOllamaEndpoint` | cross_community | 6 |
| `HandleToolbarAction → ResolveNativeOllamaModel` | cross_community | 6 |
| `TailorDialog → IsOllamaEndpoint` | cross_community | 6 |
| `ClaudeChatDrawer → IsBrowserProjectPath` | cross_community | 6 |
| `ClaudeChatDrawer → ResolveSemanticConfig` | cross_community | 6 |
| `Handle → IsOllamaEndpoint` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 23 calls |
| Ui | 20 calls |
| Components | 13 calls |
| Editor | 8 calls |
| Hooks | 3 calls |
| Stores | 2 calls |
| Cluster_333 | 2 calls |
| Cluster_318 | 2 calls |

## How to Explore

1. `context({name: "ChatComposer"})` — see callers and callees
2. `query({search_query: "claude-chat"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
