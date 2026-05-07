---
name: tools
description: "Skill for the Tools area of devprism-main. 17 symbols across 6 files."
---

# Tools

17 symbols | 6 files | Cohesion: 79%

## When to Use

- Working with code in `apps/`
- Understanding how list_agent_sessions, cmp, get_definitions work
- Modifying tools-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/agent/tools/mod.rs` | call, build_comparison_queries, get_definitions, call, resolve_tool_path (+3) |
| `apps/desktop/src-tauri/src/agent/tools/semantic_search.rs` | get_embedding, call, call |
| `apps/desktop/src-tauri/src/agent/tools/git_insight.rs` | call, test_git_insight_tool |
| `apps/desktop/src-tauri/src/agent/knowledge/mod.rs` | authorized_roots, is_path_authorized |
| `apps/desktop/src-tauri/src/agent_runtime.rs` | list_agent_sessions |
| `apps/desktop/src/components/workspace/sidebar.tsx` | cmp |

## Entry Points

Start here when exploring this area:

- **`list_agent_sessions`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:2330`
- **`cmp`** (Function) — `apps/desktop/src/components/workspace/sidebar.tsx:499`
- **`get_definitions`** (Function) — `apps/desktop/src-tauri/src/agent/tools/mod.rs:801`
- **`call`** (Function) — `apps/desktop/src-tauri/src/agent/tools/mod.rs:738`
- **`authorized_roots`** (Function) — `apps/desktop/src-tauri/src/agent/knowledge/mod.rs:74`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `list_agent_sessions` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 2330 |
| `cmp` | Function | `apps/desktop/src/components/workspace/sidebar.tsx` | 499 |
| `get_definitions` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 801 |
| `call` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 738 |
| `authorized_roots` | Function | `apps/desktop/src-tauri/src/agent/knowledge/mod.rs` | 74 |
| `is_path_authorized` | Function | `apps/desktop/src-tauri/src/agent/knowledge/mod.rs` | 103 |
| `get_embedding` | Function | `apps/desktop/src-tauri/src/agent/tools/semantic_search.rs` | 13 |
| `call` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 477 |
| `build_comparison_queries` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 622 |
| `call` | Function | `apps/desktop/src-tauri/src/agent/tools/git_insight.rs` | 41 |
| `test_git_insight_tool` | Function | `apps/desktop/src-tauri/src/agent/tools/git_insight.rs` | 201 |
| `resolve_tool_path` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 777 |
| `call` | Function | `apps/desktop/src-tauri/src/agent/tools/semantic_search.rs` | 77 |
| `call` | Function | `apps/desktop/src-tauri/src/agent/tools/semantic_search.rs` | 133 |
| `call` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 310 |
| `should_skip_path` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 658 |
| `looks_text_file` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 665 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Call → Get_knowledge_dir` | cross_community | 9 |
| `Call → Init_feature_tables` | cross_community | 8 |
| `Call → LinkedProject` | cross_community | 7 |
| `Run_repl → Cmp` | cross_community | 5 |
| `Run_chat → Cmp` | cross_community | 5 |
| `Run_task → Cmp` | cross_community | 5 |
| `Continue_task → Cmp` | cross_community | 5 |
| `Slash_command_delete → Cmp` | cross_community | 4 |
| `Manual_skill_delete → Cmp` | cross_community | 4 |
| `Slash_command_get → Cmp` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_49 | 1 calls |
| Cluster_51 | 1 calls |
| Agent | 1 calls |
| Knowledge | 1 calls |

## How to Explore

1. `gitnexus_context({name: "list_agent_sessions"})` — see callers and callees
2. `gitnexus_query({query: "tools"})` — find related execution flows
3. Read key files listed above for implementation details
