---
name: components
description: "Skill for the Components area of DevPrism. 74 symbols across 15 files."
---

# Components

74 symbols | 15 files | Cohesion: 64%

## When to Use

- Working with code in `apps/`
- Understanding how handleSaveApiKey, selectProviderCard, renderApiKeyForm work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/project-picker.tsx` | projectPreviewCacheKey, enqueueProjectPreviewCompile, texPreviewLines, statDateToMs, getProjectCreatedAt (+21) |
| `apps/desktop/src/components/claude-setup.tsx` | isNativeAnthropicPreset, normalizePresetBaseUrl, findOpenAiPresetIdForBaseUrl, openAiPresetIdForBaseUrl, findClaudePresetIdForBaseUrl (+15) |
| `apps/desktop/src/lib/model-capabilities.ts` | haystack, isNonChatModel, hasExplicitVisionFamily, getModelCapabilities, isChatModelOption |
| `apps/desktop/src/lib/template-preview-cache.ts` | notify, getTemplatePdfUrl, generateThumbnail |
| `apps/desktop/src/components/claude-chat/chat-messages.tsx` | useSummarize, summarize, AssistantMessage |
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | openDocument, renderThumbnail |
| `apps/desktop/src/lib/ai-assist.ts` | summarizeSection, suggestProjectName |
| `apps/desktop/src/lib/ollama.ts` | getOllamaBaseUrl, listOllamaModels |
| `apps/desktop/src/lib/space-project.ts` | applySpaceModelForProject, scaffoldMasterFile |
| `apps/desktop/src/lib/space-master.ts` | masterFileNameForKind, masterStubForKind |

## Entry Points

Start here when exploring this area:

- **`handleSaveApiKey`** (Function) — `apps/desktop/src/components/claude-setup.tsx:573`
- **`selectProviderCard`** (Function) — `apps/desktop/src/components/claude-setup.tsx:645`
- **`renderApiKeyForm`** (Function) — `apps/desktop/src/components/claude-setup.tsx:689`
- **`getTemplatePdfUrl`** (Function) — `apps/desktop/src/lib/template-preview-cache.ts:33`
- **`generateThumbnail`** (Function) — `apps/desktop/src/lib/template-preview-cache.ts:40`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `handleSaveApiKey` | Function | `apps/desktop/src/components/claude-setup.tsx` | 573 |
| `selectProviderCard` | Function | `apps/desktop/src/components/claude-setup.tsx` | 645 |
| `renderApiKeyForm` | Function | `apps/desktop/src/components/claude-setup.tsx` | 689 |
| `getTemplatePdfUrl` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 33 |
| `generateThumbnail` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 40 |
| `summarizeSection` | Function | `apps/desktop/src/lib/ai-assist.ts` | 384 |
| `ProjectPicker` | Function | `apps/desktop/src/components/project-picker.tsx` | 267 |
| `discoverDefaultProjects` | Function | `apps/desktop/src/components/project-picker.tsx` | 351 |
| `handleSelectMode` | Function | `apps/desktop/src/components/project-picker.tsx` | 412 |
| `openEditSpaceDialog` | Function | `apps/desktop/src/components/project-picker.tsx` | 699 |
| `assignProjectViaDrop` | Function | `apps/desktop/src/components/project-picker.tsx` | 710 |
| `getOllamaBaseUrl` | Function | `apps/desktop/src/lib/ollama.ts` | 54 |
| `listOllamaModels` | Function | `apps/desktop/src/lib/ollama.ts` | 60 |
| `applySpaceModelForProject` | Function | `apps/desktop/src/lib/space-project.ts` | 61 |
| `applySpaceModel` | Function | `apps/desktop/src/components/project-picker.tsx` | 376 |
| `handleOpenFolder` | Function | `apps/desktop/src/components/project-picker.tsx` | 380 |
| `handleOpenRecent` | Function | `apps/desktop/src/components/project-picker.tsx` | 400 |
| `importDroppedPaths` | Function | `apps/desktop/src/components/project-picker.tsx` | 421 |
| `isZipName` | Function | `apps/desktop/src/components/project-picker.tsx` | 422 |
| `ModelCapabilityBadges` | Function | `apps/desktop/src/components/model-capability-badges.tsx` | 11 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DocumentOutline → IsOllamaEndpoint` | cross_community | 7 |
| `RenderApiKeyForm → DeepseekOrigin` | cross_community | 7 |
| `RenderApiKeyForm → QwenOrigin` | cross_community | 7 |
| `RenderApiKeyForm → NormalizeOriginOnlyUrl` | cross_community | 7 |
| `RenderApiKeyForm → MoonshotOrigin` | cross_community | 7 |
| `ProjectPreviewCard → Has` | cross_community | 7 |
| `ProjectPreviewCard → IsOllamaEndpoint` | cross_community | 7 |
| `DocumentOutline → ResolveNativeOllamaModel` | cross_community | 6 |
| `TemplateCard → Has` | cross_community | 6 |
| `ScratchForm → IsOllamaEndpoint` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Ui | 6 calls |
| Editor | 5 calls |
| Tauri | 5 calls |
| Mupdf | 4 calls |
| Template-gallery | 3 calls |
| Cluster_156 | 3 calls |
| Workspace | 3 calls |
| Cluster_168 | 3 calls |

## How to Explore

1. `gitnexus_context({name: "handleSaveApiKey"})` — see callers and callees
2. `gitnexus_query({query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
