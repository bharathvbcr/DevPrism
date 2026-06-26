---
name: scripts
description: "Skill for the Scripts area of DevPrism. 18 symbols across 5 files."
---

# Scripts

18 symbols | 5 files | Cohesion: 94%

## When to Use

- Working with code in `scripts/`
- Understanding how getAllTemplates, getTemplatesByCategory, getCategories work
- Modifying scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/verify-agent-instructions.js` | getAllInstructionFiles, getStagedPaths, isInstructionFile, stagedContent, fileContent (+5) |
| `apps/desktop/src/lib/template-registry.ts` | getAllTemplates, getTemplatesByCategory, getCategories, searchTemplates |
| `apps/desktop/scripts/generate-previews.ts` | loadTemplates, main |
| `apps/desktop/src/stores/template-store.ts` | computeFiltered |
| `apps/desktop/src/components/template-gallery/category-sidebar.tsx` | CategorySidebar |

## Entry Points

Start here when exploring this area:

- **`getAllTemplates`** (Function) — `apps/desktop/src/lib/template-registry.ts:3222`
- **`getTemplatesByCategory`** (Function) — `apps/desktop/src/lib/template-registry.ts:3230`
- **`getCategories`** (Function) — `apps/desktop/src/lib/template-registry.ts:3236`
- **`searchTemplates`** (Function) — `apps/desktop/src/lib/template-registry.ts:3240`
- **`CategorySidebar`** (Function) — `apps/desktop/src/components/template-gallery/category-sidebar.tsx:45`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getAllTemplates` | Function | `apps/desktop/src/lib/template-registry.ts` | 3222 |
| `getTemplatesByCategory` | Function | `apps/desktop/src/lib/template-registry.ts` | 3230 |
| `getCategories` | Function | `apps/desktop/src/lib/template-registry.ts` | 3236 |
| `searchTemplates` | Function | `apps/desktop/src/lib/template-registry.ts` | 3240 |
| `CategorySidebar` | Function | `apps/desktop/src/components/template-gallery/category-sidebar.tsx` | 45 |
| `getAllInstructionFiles` | Function | `scripts/verify-agent-instructions.js` | 12 |
| `getStagedPaths` | Function | `scripts/verify-agent-instructions.js` | 23 |
| `isInstructionFile` | Function | `scripts/verify-agent-instructions.js` | 58 |
| `stagedContent` | Function | `scripts/verify-agent-instructions.js` | 63 |
| `fileContent` | Function | `scripts/verify-agent-instructions.js` | 76 |
| `hasAllRequiredSections` | Function | `scripts/verify-agent-instructions.js` | 84 |
| `hasTrackedPath` | Function | `scripts/verify-agent-instructions.js` | 88 |
| `stagedHasInstruction` | Function | `scripts/verify-agent-instructions.js` | 95 |
| `reportError` | Function | `scripts/verify-agent-instructions.js` | 104 |
| `main` | Function | `scripts/verify-agent-instructions.js` | 109 |
| `loadTemplates` | Function | `apps/desktop/scripts/generate-previews.ts` | 22 |
| `main` | Function | `apps/desktop/scripts/generate-previews.ts` | 36 |
| `computeFiltered` | Function | `apps/desktop/src/stores/template-store.ts` | 29 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Editor | 1 calls |

## How to Explore

1. `gitnexus_context({name: "getAllTemplates"})` — see callers and callees
2. `gitnexus_query({query: "scripts"})` — find related execution flows
3. Read key files listed above for implementation details
