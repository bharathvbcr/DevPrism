---
name: cluster-66
description: "Skill for the Cluster_66 area of DevPrism. 23 symbols across 3 files."
---

# Cluster_66

23 symbols | 3 files | Cohesion: 78%

## When to Use

- Working with code in `apps/`
- Understanding how spawn_claude_process, execute_claude_code, continue_claude_code work
- Modifying cluster_66-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/claude.rs` | is_claude_model_selector, normalize_provider_model_override, stored_openai_compatible_credential_by_id, find_claude_in_registry_path, expand_env_vars (+15) |
| `apps/desktop/src-tauri/src/app_nap.rs` | acquire, begin |
| `apps/desktop/src-tauri/src/claude_process.rs` | spawn_claude_process |

## Entry Points

Start here when exploring this area:

- **`spawn_claude_process`** (Function) — `apps/desktop/src-tauri/src/claude_process.rs:64`
- **`execute_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3239`
- **`continue_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3282`
- **`resume_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3325`
- **`begin`** (Function) — `apps/desktop/src-tauri/src/app_nap.rs:78`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `spawn_claude_process` | Function | `apps/desktop/src-tauri/src/claude_process.rs` | 64 |
| `execute_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3239 |
| `continue_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3282 |
| `resume_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3325 |
| `begin` | Function | `apps/desktop/src-tauri/src/app_nap.rs` | 78 |
| `is_claude_model_selector` | Function | `apps/desktop/src-tauri/src/claude.rs` | 630 |
| `normalize_provider_model_override` | Function | `apps/desktop/src-tauri/src/claude.rs` | 639 |
| `stored_openai_compatible_credential_by_id` | Function | `apps/desktop/src-tauri/src/claude.rs` | 691 |
| `find_claude_in_registry_path` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1206 |
| `expand_env_vars` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1253 |
| `find_claude_binary` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1296 |
| `unix_claude_candidate_paths` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1481 |
| `clear_anthropic_provider_env` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1965 |
| `with_prompt_transport` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1988 |
| `common_claude_args` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2526 |
| `execute_openai_compatible_via_claude_proxy` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2991 |
| `execute_openai_compatible_provider` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3040 |
| `execute_openai_compatible_via_native_anthropic` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3076 |
| `test_common_claude_args_has_required_flags` | Function | `apps/desktop/src-tauri/src/claude.rs` | 4519 |
| `test_common_claude_args_system_prompt_mentions_latex` | Function | `apps/desktop/src-tauri/src/claude.rs` | 4531 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Inline_transform_text → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_complete → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_complete_stream → Get_claude_prism_auth_path` | cross_community | 5 |
| `Ai_complete_stream → Restrict_auth_file_permissions` | cross_community | 5 |
| `Execute_openai_compatible_via_claude_proxy → Find_header_end` | cross_community | 5 |
| `Execute_openai_compatible_via_claude_proxy → HttpRequest` | cross_community | 5 |
| `Execute_openai_compatible_via_claude_proxy → Request_contains_openai_image_parts` | cross_community | 5 |
| `Compile_latex → Token` | cross_community | 4 |
| `Execute_claude_code → Get_claude_prism_auth_path` | cross_community | 4 |
| `Execute_claude_code → Restrict_auth_file_permissions` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_73 | 5 calls |
| Cluster_79 | 3 calls |
| Cluster_70 | 2 calls |
| Cluster_74 | 2 calls |
| Cluster_65 | 1 calls |
| Cluster_69 | 1 calls |
| Cluster_72 | 1 calls |
| Cluster_38 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "spawn_claude_process"})` — see callers and callees
2. `gitnexus_query({query: "cluster_66"})` — find related execution flows
3. Read key files listed above for implementation details
