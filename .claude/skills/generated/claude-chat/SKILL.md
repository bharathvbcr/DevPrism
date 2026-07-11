---
name: claude-chat
description: "Skill for the Claude-chat area of DevPrism. 208 symbols across 33 files."
---

# Claude-chat

208 symbols | 33 files | Cohesion: 75%

## When to Use

- Working with code in `apps/`
- Understanding how ChatComposer, cancelExecution, setSelectedModel work
- Modifying claude-chat-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/claude-chat/chat-composer.tsx` | cleanupTemporaryFilePaths, cleanupTemporaryPinnedContext, getFileIcon, formatGuidanceText, effortShortLabel (+45) |
| `apps/desktop/src/components/claude-chat/tool-widgets.tsx` | ToolWidget, StatusIcon, DisclosureChevron, ToolRowButton, WriteWidget (+19) |
| `apps/desktop/src/components/claude-chat/chat-messages.tsx` | ContextTruncationNotice, MessageActions, RegenerateButton, resendFromMessage, SummaryCallout (+18) |
| `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx` | ClaudeChatDrawer, updateSize, openDrawer, onOpen, panelStyle (+9) |
| `apps/desktop/src/components/claude-chat/slash-command-picker.tsx` | scopeToTab, filterAndSort, tabCounts, filtered, searchGroups (+9) |
| `apps/desktop/src/lib/ollama.ts` | formatOllamaModelSize, isOllamaEndpoint, resolveOllamaCredential, resolveNativeOllamaModel, getOllamaBaseUrl (+3) |
| `apps/desktop/src/components/claude-chat/markdown-renderer.tsx` | MarkdownRenderer, looksLikeShellCommand, isShellCodeBlock, code, CodeBlock (+3) |
| `apps/desktop/src/components/claude-chat/chat-tab-bar.tsx` | ChatTabBar, setActiveTab, closeTab, handleKeyDown, handleClose (+3) |
| `apps/desktop/src/components/claude-chat/context-usage-indicator.tsx` | ContextUsageIndicator, latestContextTruncation, truncation, latestPromptTokens, promptTokens (+2) |
| `apps/desktop/src/components/claude-chat/proposed-changes-panel.tsx` | rawDiff, diffRows, DiffLinePrefix, UnifiedDiffView, SplitDiffView (+2) |

## Entry Points

Start here when exploring this area:

- **`ChatComposer`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:297`
- **`cancelExecution`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:301`
- **`setSelectedModel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:310`
- **`setSelectedProviderModel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:320`
- **`setEffortLevel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:324`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ChatComposer` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 297 |
| `cancelExecution` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 301 |
| `setSelectedModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 310 |
| `setSelectedProviderModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 320 |
| `setEffortLevel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 324 |
| `setNativeOllamaModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 371 |
| `loadOllamaModels` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 741 |
| `refreshOllamaModels` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 760 |
| `importFiles` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 849 |
| `consumePendingAttachments` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 855 |
| `consumePendingPinnedContextRemovals` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 861 |
| `consumePendingComposerInput` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 903 |
| `buildPinnedContextForFile` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 992 |
| `selectMention` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1011 |
| `clearComposerInput` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1090 |
| `dismissGhostText` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1104 |
| `acceptGhostText` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1232 |
| `handleImprovePrompt` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1249 |
| `handleKeyDown` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1596 |
| `ContextUsageIndicator` | Function | `apps/desktop/src/components/claude-chat/context-usage-indicator.tsx` | 88 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandlePaste → ParseBrowserRoot` | cross_community | 6 |
| `HandlePaste → BrowserRootPath` | cross_community | 6 |
| `HandlePaste → RelativeFromBrowserAbsolute` | cross_community | 6 |
| `TemplateGallery → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → IsOllamaEndpoint` | cross_community | 6 |
| `CommentComposer → IsOllamaEndpoint` | cross_community | 6 |
| `HandleToolbarAction → ResolveNativeOllamaModel` | cross_community | 6 |
| `TailorDialog → IsOllamaEndpoint` | cross_community | 6 |
| `App → IsOllamaEndpoint` | cross_community | 5 |
| `SpaceQuickActions → ResolveNativeOllamaModel` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 26 calls |
| Ui | 23 calls |
| Components | 16 calls |
| Editor | 8 calls |
| Hooks | 4 calls |
| Stores | 3 calls |
| Cluster_341 | 2 calls |
| Cluster_324 | 2 calls |

## How to Explore

1. `context({name: "ChatComposer"})` — see callers and callees
2. `query({search_query: "claude-chat"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
