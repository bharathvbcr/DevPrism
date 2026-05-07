---
name: knowledge
description: "Skill for the Knowledge area of devprism-main. 48 symbols across 5 files."
---

# Knowledge

48 symbols | 5 files | Cohesion: 86%

## When to Use

- Working with code in `apps/`
- Understanding how get_resume_knowledge_settings, set_resume_knowledge_settings, set_personal_bio work
- Modifying knowledge-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | get_db_path, new, list_observations, init_db, list_linked_projects_from_db (+13) |
| `apps/desktop/src-tauri/src/agent/knowledge/mod.rs` | get_knowledge_dir, get_projects_file, new, add_authorized_path, remove_authorized_path (+12) |
| `apps/desktop/src-tauri/src/lib.rs` | save_project_summary, add_linked_project, analyze_linked_project, merge_imported_knowledgebase_settings, imported_settings_merge_without_overwriting_api_key (+2) |
| `apps/desktop/src-tauri/src/agent_runtime.rs` | get_resume_knowledge_settings, set_resume_knowledge_settings, set_personal_bio |
| `apps/desktop/src-tauri/src/agent/knowledge/vector_store.rs` | get_all_chunks, search, cosine_similarity |

## Entry Points

Start here when exploring this area:

- **`get_resume_knowledge_settings`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:2826`
- **`set_resume_knowledge_settings`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:2847`
- **`set_personal_bio`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:2951`
- **`get_db_path`** (Function) — `apps/desktop/src-tauri/src/agent/knowledge/cache.rs:8`
- **`new`** (Function) — `apps/desktop/src-tauri/src/agent/knowledge/cache.rs:21`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `get_resume_knowledge_settings` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 2826 |
| `set_resume_knowledge_settings` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 2847 |
| `set_personal_bio` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 2951 |
| `get_db_path` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 8 |
| `new` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 21 |
| `list_observations` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 59 |
| `init_db` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 85 |
| `list_linked_projects_from_db` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 145 |
| `sync_manual_skill` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 183 |
| `delete_manual_skill` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 221 |
| `list_manual_skills_from_db` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 244 |
| `sync_resume_knowledge` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 271 |
| `get_resume_knowledge` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 320 |
| `upsert_project_summary` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 362 |
| `sync_project_summaries` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 378 |
| `list_project_summaries` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 398 |
| `add_observation` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 479 |
| `list_observations` | Function | `apps/desktop/src-tauri/src/agent/knowledge/cache.rs` | 494 |
| `get_knowledge_dir` | Function | `apps/desktop/src-tauri/src/agent/knowledge/mod.rs` | 34 |
| `get_projects_file` | Function | `apps/desktop/src-tauri/src/agent/knowledge/mod.rs` | 43 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Call → Get_knowledge_dir` | cross_community | 9 |
| `Call → Init_feature_tables` | cross_community | 8 |
| `Add_project_detailed → Get_knowledge_dir` | cross_community | 8 |
| `Analyze_project → Get_knowledge_dir` | cross_community | 8 |
| `Call → LinkedProject` | cross_community | 7 |
| `Add_project_detailed → Init_feature_tables` | cross_community | 7 |
| `Analyze_project → Init_feature_tables` | cross_community | 7 |
| `Execute_native_agent → Get_knowledge_dir` | cross_community | 6 |
| `Add_project → Get_knowledge_dir` | cross_community | 6 |
| `Add_project → Init_feature_tables` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Providers | 2 calls |
| Cluster_54 | 1 calls |
| Get_ | 1 calls |

## How to Explore

1. `gitnexus_context({name: "get_resume_knowledge_settings"})` — see callers and callees
2. `gitnexus_query({query: "knowledge"})` — find related execution flows
3. Read key files listed above for implementation details
