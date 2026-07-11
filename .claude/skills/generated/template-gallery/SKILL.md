---
name: template-gallery
description: "Skill for the Template-gallery area of DevPrism. 33 symbols across 8 files."
---

# Template-gallery

33 symbols | 8 files | Cohesion: 73%

## When to Use

- Working with code in `apps/`
- Understanding how getFallbackThumbnail, TemplateCard, openPreview work
- Modifying template-gallery-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/components/template-gallery/template-preview.tsx` | closePreview, addRecentProject, setLastProjectFolder, openProject, handleChooseFolder (+4) |
| `apps/desktop/src/components/template-gallery/template-gallery.tsx` | TemplateGallery, setSearchQuery, reset, handleKeyDown, GroupedGrid (+2) |
| `apps/desktop/src/components/template-gallery/template-card.tsx` | getFallbackThumbnail, TemplateCard, openPreview, thumbnailUrl, failed |
| `apps/desktop/src/lib/template-registry.ts` | getAllTemplates, getTemplateSkeleton, getTemplatesByCategory, getCategories |
| `apps/desktop/src/stores/template-store.ts` | useTemplateStore, reset |
| `apps/desktop/src/lib/project-attachments.ts` | isPdfPath, buildReferenceFilesSection |
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
| `closePreview` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 75 |
| `addRecentProject` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 117 |
| `setLastProjectFolder` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 119 |
| `openProject` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 120 |
| `handleChooseFolder` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 425 |
| `handleCreate` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 438 |
| `buildReferenceFilesSection` | Function | `apps/desktop/src/lib/project-attachments.ts` | 41 |
| `getTemplateSkeleton` | Function | `apps/desktop/src/lib/template-registry.ts` | 3265 |
| `CategorySidebar` | Function | `apps/desktop/src/components/template-gallery/category-sidebar.tsx` | 45 |
| `setSelectedCategory` | Function | `apps/desktop/src/components/template-gallery/category-sidebar.tsx` | 47 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleCreate → OpfsProjectsRoot` | cross_community | 9 |
| `HandleCreate → GetFsaDirectoryAtRelativePath` | cross_community | 7 |
| `HandleCreate → ParseBrowserRoot` | cross_community | 6 |
| `HandleCreate → BrowserRootPath` | cross_community | 6 |
| `HandleCreate → RelativeFromBrowserAbsolute` | cross_community | 6 |
| `TemplateGallery → IsOllamaEndpoint` | cross_community | 6 |
| `TemplateGallery → AcquireAiSlot` | cross_community | 5 |
| `TemplateGallery → ReleaseAiSlot` | cross_community | 5 |
| `HandleCreate → IsBrowserProjectPath` | cross_community | 4 |
| `TemplateGallery → CosineSimilarity` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Workspace | 6 calls |
| Components | 3 calls |
| Browser-project | 3 calls |
| Cluster_367 | 2 calls |
| Cluster_362 | 1 calls |
| Semantic-layer | 1 calls |
| Cluster_324 | 1 calls |

## How to Explore

1. `context({name: "getFallbackThumbnail"})` — see callers and callees
2. `query({search_query: "template-gallery"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
