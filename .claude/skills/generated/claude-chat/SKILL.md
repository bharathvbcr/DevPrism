---
name: claude-chat
description: "Skill for the Claude-chat area of DevPrism. 218 symbols across 33 files."
---

# Claude-chat

218 symbols | 33 files | Cohesion: 76%

## When to Use

- Working with code in `apps/`
- Understanding how ChatComposer, cancelExecution, setSelectedModel work
- Modifying claude-chat-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/claude-chat/chat-composer.tsx` | cleanupTemporaryFilePaths, cleanupTemporaryPinnedContext, getFileIcon, formatGuidanceText, effortShortLabel (+50) |
| `apps/desktop/src/components/claude-chat/tool-widgets.tsx` | ToolWidget, StatusIcon, DisclosureChevron, ToolRowButton, WriteWidget (+19) |
| `apps/desktop/src/components/claude-chat/chat-messages.tsx` | ContextTruncationNotice, ChatMessages, MessageActions, RegenerateButton, resendFromMessage (+17) |
| `apps/desktop/src/components/claude-chat/slash-command-picker.tsx` | getCommandIcon, SkillPreview, SlashCommandPicker, renderItem, renderEmptyState (+11) |
| `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx` | ClaudeChatDrawer, updateSize, openDrawer, onOpen, panelStyle (+9) |
| `apps/desktop/src/lib/ollama.ts` | formatOllamaModelSize, isOllamaEndpoint, resolveOllamaCredential, resolveNativeOllamaModel, getOllamaBaseUrl (+3) |
| `apps/desktop/src/components/claude-chat/markdown-renderer.tsx` | MarkdownRenderer, looksLikeShellCommand, isShellCodeBlock, code, CodeBlock (+3) |
| `apps/desktop/src/components/claude-chat/chat-tab-bar.tsx` | ChatTabBar, setActiveTab, closeTab, handleKeyDown, handleClose (+3) |
| `apps/desktop/src/components/claude-chat/context-usage-indicator.tsx` | ContextUsageIndicator, latestContextTruncation, truncation, latestPromptTokens, promptTokens (+2) |
| `apps/desktop/src/components/claude-chat/proposed-changes-panel.tsx` | rawDiff, diffRows, DiffLinePrefix, UnifiedDiffView, SplitDiffView (+2) |

## Entry Points

Start here when exploring this area:

- **`ChatComposer`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:310`
- **`cancelExecution`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:314`
- **`setSelectedModel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:323`
- **`setSelectedProviderModel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:333`
- **`setEffortLevel`** (Function) — `apps/desktop/src/components/claude-chat/chat-composer.tsx:337`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ChatComposer` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 310 |
| `cancelExecution` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 314 |
| `setSelectedModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 323 |
| `setSelectedProviderModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 333 |
| `setEffortLevel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 337 |
| `setAgentBackend` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 380 |
| `setNativeOllamaModel` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 387 |
| `checkCursorStatus` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 438 |
| `checkGroqStatus` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 439 |
| `openBackendSetup` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 577 |
| `selectAgentBackend` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 596 |
| `loadOllamaModels` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 810 |
| `refreshOllamaModels` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 829 |
| `importFiles` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 918 |
| `consumePendingAttachments` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 924 |
| `consumePendingPinnedContextRemovals` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 930 |
| `consumePendingComposerInput` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 972 |
| `buildPinnedContextForFile` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1061 |
| `selectMention` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1080 |
| `clearComposerInput` | Function | `apps/desktop/src/components/claude-chat/chat-composer.tsx` | 1159 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandlePaste → ParseBrowserRoot` | cross_community | 6 |
| `HandlePaste → BrowserRootPath` | cross_community | 6 |
| `HandlePaste → RelativeFromBrowserAbsolute` | cross_community | 6 |
| `TemplateGallery → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → IsOllamaEndpoint` | cross_community | 6 |
| `CommentComposer → IsOllamaEndpoint` | cross_community | 6 |
| `TailorDialog → IsOllamaEndpoint` | cross_community | 6 |
| `SpaceQuickActions → ResolveNativeOllamaModel` | cross_community | 5 |
| `CommentComposer → ResolveNativeOllamaModel` | cross_community | 5 |
| `ClaudeChatDrawer → HasThinkingBlock` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Ui | 24 calls |
| Career | 22 calls |
| Components | 18 calls |
| Stores | 10 calls |
| Editor | 8 calls |
| Hooks | 4 calls |
| Workspace | 3 calls |
| Cluster_348 | 2 calls |

## How to Explore

1. `context({name: "ChatComposer"})` — see callers and callees
2. `query({search_query: "claude-chat"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
