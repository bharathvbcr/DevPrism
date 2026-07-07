---
name: cluster-1
description: "Skill for the Cluster_1 area of DevPrism. 26 symbols across 4 files."
---

# Cluster_1

26 symbols | 4 files | Cohesion: 79%

## When to Use

- Working with code in `apps/`
- Understanding how start_openai_anthropic_proxy, begin, execute_claude_code work
- Modifying cluster_1-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/claude.rs` | is_claude_model_selector, normalize_provider_model_override, stored_openai_compatible_credential_by_id, find_claude_in_registry_path, expand_env_vars (+17) |
| `apps/desktop/src-tauri/src/app_nap.rs` | acquire, begin |
| `apps/desktop/src-tauri/src/anthropic_proxy.rs` | start_openai_anthropic_proxy |
| `apps/desktop/src-tauri/src/claude_process.rs` | spawn_claude_process |

## Entry Points

Start here when exploring this area:

- **`start_openai_anthropic_proxy`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy.rs:29`
- **`begin`** (Function) — `apps/desktop/src-tauri/src/app_nap.rs:78`
- **`execute_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3279`
- **`continue_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3324`
- **`resume_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3367`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `start_openai_anthropic_proxy` | Function | `apps/desktop/src-tauri/src/anthropic_proxy.rs` | 29 |
| `begin` | Function | `apps/desktop/src-tauri/src/app_nap.rs` | 78 |
| `execute_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3279 |
| `continue_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3324 |
| `resume_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3367 |
| `spawn_claude_process` | Function | `apps/desktop/src-tauri/src/claude_process.rs` | 64 |
| `acquire` | Function | `apps/desktop/src-tauri/src/app_nap.rs` | 42 |
| `is_claude_model_selector` | Function | `apps/desktop/src-tauri/src/claude.rs` | 656 |
| `normalize_provider_model_override` | Function | `apps/desktop/src-tauri/src/claude.rs` | 665 |
| `stored_openai_compatible_credential_by_id` | Function | `apps/desktop/src-tauri/src/claude.rs` | 717 |
| `find_claude_in_registry_path` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1241 |
| `expand_env_vars` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1288 |
| `find_claude_binary` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1331 |
| `unix_claude_candidate_paths` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1516 |
| `clear_anthropic_provider_env` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2000 |
| `with_prompt_transport` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2023 |
| `common_claude_args` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2561 |
| `execute_openai_compatible_via_claude_proxy` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3026 |
| `execute_openai_compatible_provider` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3080 |
| `execute_openai_compatible_via_native_anthropic` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3116 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Inline_transform_text → Get_claude_prism_auth_path` | cross_community | 6 |
| `Inline_transform_text → Restrict_auth_file_permissions` | cross_community | 6 |
| `Ai_caption → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_caption → Restrict_auth_file_permissions` | cross_community | 6 |
| `Ai_complete_stream → Get_claude_prism_auth_path` | cross_community | 5 |
| `Ai_complete_stream → Restrict_auth_file_permissions` | cross_community | 5 |
| `Execute_claude_code → Get_claude_prism_auth_path` | cross_community | 4 |
| `Execute_claude_code → Restrict_auth_file_permissions` | cross_community | 4 |
| `Execute_claude_code → Strip_nul` | cross_community | 4 |
| `Execute_claude_code → With_prompt_transport` | intra_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_27 | 5 calls |
| Cluster_34 | 3 calls |
| Cluster_24 | 2 calls |
| Cluster_28 | 2 calls |
| Cluster_35 | 1 calls |
| Cluster_19 | 1 calls |
| Cluster_23 | 1 calls |
| Cluster_26 | 1 calls |

## How to Explore

1. `context({name: "start_openai_anthropic_proxy"})` — see callers and callees
2. `query({search_query: "cluster_1"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
