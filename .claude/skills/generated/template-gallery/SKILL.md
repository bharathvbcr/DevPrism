---
name: template-gallery
description: "Skill for the Template-gallery area of DevPrism. 19 symbols across 9 files."
---

# Template-gallery

19 symbols | 9 files | Cohesion: 76%

## When to Use

- Working with code in `apps/`
- Understanding how getTemplateSkeleton, formatNewProjectSetupToast, normalizeProjectName work
- Modifying template-gallery-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src/lib/project-attachments.ts` | baseName, isPdfPath, importReferenceFiles, buildReferenceFilesSection |
| `apps/desktop/src/components/template-gallery/template-preview.tsx` | TemplatePreview, handleRemoveAttachment, handleCreate |
| `apps/desktop/src/lib/mupdf/mupdf-client.ts` | countPages, getPageSize, drawPage |
| `apps/desktop/src/lib/project-name.ts` | normalizeProjectName, getProjectNameError |
| `apps/desktop/src/lib/template-preview-cache.ts` | getThumbnail, isThumbnailFailed |
| `apps/desktop/src/components/template-gallery/template-card.tsx` | getFallbackThumbnail, TemplateCard |
| `apps/desktop/src/lib/template-registry.ts` | getTemplateSkeleton |
| `apps/desktop/src/lib/space-project.ts` | formatNewProjectSetupToast |
| `apps/desktop/src/components/project-wizard.tsx` | handleCreate |

## Entry Points

Start here when exploring this area:

- **`getTemplateSkeleton`** (Function) — `apps/desktop/src/lib/template-registry.ts:3265`
- **`formatNewProjectSetupToast`** (Function) — `apps/desktop/src/lib/space-project.ts:167`
- **`normalizeProjectName`** (Function) — `apps/desktop/src/lib/project-name.ts:0`
- **`getProjectNameError`** (Function) — `apps/desktop/src/lib/project-name.ts:4`
- **`importReferenceFiles`** (Function) — `apps/desktop/src/lib/project-attachments.ts:14`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getTemplateSkeleton` | Function | `apps/desktop/src/lib/template-registry.ts` | 3265 |
| `formatNewProjectSetupToast` | Function | `apps/desktop/src/lib/space-project.ts` | 167 |
| `normalizeProjectName` | Function | `apps/desktop/src/lib/project-name.ts` | 0 |
| `getProjectNameError` | Function | `apps/desktop/src/lib/project-name.ts` | 4 |
| `importReferenceFiles` | Function | `apps/desktop/src/lib/project-attachments.ts` | 14 |
| `buildReferenceFilesSection` | Function | `apps/desktop/src/lib/project-attachments.ts` | 35 |
| `TemplatePreview` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 65 |
| `handleRemoveAttachment` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 402 |
| `handleCreate` | Function | `apps/desktop/src/components/template-gallery/template-preview.tsx` | 419 |
| `getThumbnail` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 24 |
| `isThumbnailFailed` | Function | `apps/desktop/src/lib/template-preview-cache.ts` | 28 |
| `getFallbackThumbnail` | Function | `apps/desktop/src/components/template-gallery/template-card.tsx` | 104 |
| `TemplateCard` | Function | `apps/desktop/src/components/template-gallery/template-card.tsx` | 117 |
| `countPages` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 14 |
| `getPageSize` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 15 |
| `drawPage` | Method | `apps/desktop/src/lib/mupdf/mupdf-client.ts` | 17 |
| `handleCreate` | Function | `apps/desktop/src/components/project-wizard.tsx` | 246 |
| `baseName` | Function | `apps/desktop/src/lib/project-attachments.ts` | 6 |
| `isPdfPath` | Function | `apps/desktop/src/lib/project-attachments.ts` | 10 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `TemplateCard → Has` | cross_community | 6 |
| `TemplatePreview → Has` | cross_community | 5 |
| `TemplatePreview → IsOllamaEndpoint` | cross_community | 4 |
| `HandleCreate → GetUniqueTargetName` | cross_community | 4 |
| `HandleCreate → GetUniqueTargetName` | cross_community | 4 |
| `HandleCreate → NormalizeProjectName` | intra_community | 3 |
| `HandleCreate → BaseName` | intra_community | 3 |
| `HandleCreate → NormalizeProjectName` | intra_community | 3 |
| `HandleCreate → BaseName` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 5 calls |
| Editor | 3 calls |
| Cluster_156 | 2 calls |
| Mupdf | 2 calls |

## How to Explore

1. `gitnexus_context({name: "getTemplateSkeleton"})` — see callers and callees
2. `gitnexus_query({query: "template-gallery"})` — find related execution flows
3. Read key files listed above for implementation details
