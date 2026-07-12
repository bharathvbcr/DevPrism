---
name: template-gallery
description: "Skill for the Template-gallery area of DevPrism. 31 symbols across 8 files."
---

# Template-gallery

31 symbols | 8 files | Cohesion: 71%

## When to Use

- Working with code in `apps/`
- Understanding how getFallbackThumbnail, TemplateCard, openPreview work
- Modifying template-gallery-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/template-gallery/template-preview.tsx` | addRecentProject, setLastProjectFolder, openProject, handleChooseFolder, handleCreate (+3) |
| `apps/desktop/src/components/template-gallery/template-gallery.tsx` | TemplateGallery, setSearchQuery, reset, handleKeyDown, GroupedGrid (+2) |
| `apps/desktop/src/components/template-gallery/template-card.tsx` | getFallbackThumbnail, TemplateCard, openPreview, thumbnailUrl, failed |
| `apps/desktop/src/lib/template-registry.ts` | getAllTemplates, getTemplatesByCategory, getCategories |
| `apps/desktop/src/stores/template-store.ts` | useTemplateStore, reset |
| `apps/desktop/src/lib/project-name.ts` | normalizeProjectName, getProjectNameError |
| `apps/desktop/src/components/template-gallery/category-sidebar.tsx` | CategorySidebar, setSelectedCategory |
| `apps/desktop/src/lib/template-preview-cache.ts` | getThumbnail, isThumbnailFailed |

## Entry Points

Start here when exploring this area:

- **`getFallbackThumbnail`** (Function) — `apps/desktop/src/components/template-gallery/template-card.tsx:104`
- **`TemplateCard`** (Function) — `apps/desktop/src/components/template-gallery/template-card.tsx:117`
- **`openPreview`** (Function) — `apps/desktop/src/components/template-gallery/template-card.tsx:118`
- **`TemplateGallery`** (Function) — `apps/desktop/src/components/template-gallery/template-gallery.tsx:35`
- **`setSearchQuery`** (Function) — `apps/desktop/src/components/template-gallery/template-gallery.tsx:41`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getFallbackThumbnail` | Function | `apps/desktop/src/components/template-gallery/template-card.tsx` | 104 |
| `TemplateCard` | Function | `apps/desktop/src/components/template-gallery/template-card.tsx` | 117 |
| `openPreview` | Function | `apps/desktop/src/components/template-gallery/template-card.tsx` | 118 |
| `TemplateGallery` | Function | `apps/desktop/src/components/template-gallery/template-gallery.tsx` | 35 |
| `setSearchQuery` | Function | `apps/desktop/src/components/template-gallery/template-gallery.tsx` | 41 |
| `reset` | Function | `apps/desktop/src/components/template-gallery/template-gallery.tsx` | 44 |
| `handleKeyDown` | Function | `apps/desktop/src/components/template-gallery/template-gallery.tsx` | 135 |
| `getAllTemplates` | Function | `apps/desktop/src/lib/template-registry.ts` | 3222 |
| `useTemplateStore` | Function | `apps/desktop/src/stores/template-store.ts` | 40 |
| `reset` | Function | `apps/desktop/src/stores/template-store.ts` | 65 |
| `addRecentProject` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 117 |
| `setLastProjectFolder` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 119 |
| `openProject` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 120 |
| `handleChooseFolder` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 425 |
| `handleCreate` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 438 |
| `normalizeProjectName` | Function | `apps/desktop/src/lib/project-name.ts` | 0 |
| `getProjectNameError` | Function | `apps/desktop/src/lib/project-name.ts` | 4 |
| `CategorySidebar` | Function | `apps/desktop/src/components/template-gallery/category-sidebar.tsx` | 45 |
| `setSelectedCategory` | Function | `apps/desktop/src/components/template-gallery/category-sidebar.tsx` | 47 |
| `getTemplatesByCategory` | Function | `apps/desktop/src/lib/template-registry.ts` | 3230 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleCreate → OpfsProjectsRoot` | cross_community | 9 |
| `HandleCreate → GetFsaDirectoryAtRelativePath` | cross_community | 7 |
| `HandleCreate → ParseBrowserRoot` | cross_community | 6 |
| `HandleCreate → BrowserRootPath` | cross_community | 6 |
| `HandleCreate → RelativeFromBrowserAbsolute` | cross_community | 6 |
| `TemplateGallery → IsOllamaEndpoint` | cross_community | 6 |
| `TemplateGallery → ThrowIfAborted` | cross_community | 5 |
| `TemplateGallery → IsCliProviderId` | cross_community | 5 |
| `TemplateGallery → AcquireAiSlot` | cross_community | 5 |
| `HandleCreate → IsBrowserProjectPath` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Career | 4 calls |
| Browser-project | 3 calls |
| Components | 3 calls |
| Mupdf | 3 calls |
| Workspace | 2 calls |
| Cluster_405 | 1 calls |
| Semantic-layer | 1 calls |
| Cluster_320 | 1 calls |

## How to Explore

1. `context({name: "getFallbackThumbnail"})` — see callers and callees
2. `query({search_query: "template-gallery"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
