---
name: cluster-3
description: "Skill for the Cluster_3 area of DevPrism. 24 symbols across 3 files."
---

# Cluster_3

24 symbols | 3 files | Cohesion: 79%

## When to Use

- Working with code in `apps/`
- Understanding how spawn_claude_process, start_openai_anthropic_proxy, execute_claude_code work
- Modifying cluster_3-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/claude.rs` | is_claude_model_selector, normalize_provider_model_override, stored_openai_compatible_credential_by_id, find_claude_in_registry_path, expand_env_vars (+17) |
| `apps/desktop/src-tauri/src/agent_process.rs` | spawn_claude_process |
| `apps/desktop/src-tauri/src/anthropic_proxy.rs` | start_openai_anthropic_proxy |

## Entry Points

Start here when exploring this area:

- **`spawn_claude_process`** (Function) — `apps/desktop/src-tauri/src/agent_process.rs:303`
- **`start_openai_anthropic_proxy`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy.rs:29`
- **`execute_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3336`
- **`continue_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3381`
- **`resume_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3424`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `spawn_claude_process` | Function | `apps/desktop/src-tauri/src/agent_process.rs` | 303 |
| `start_openai_anthropic_proxy` | Function | `apps/desktop/src-tauri/src/anthropic_proxy.rs` | 29 |
| `execute_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3336 |
| `continue_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3381 |
| `resume_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3424 |
| `is_claude_model_selector` | Function | `apps/desktop/src-tauri/src/claude.rs` | 658 |
| `normalize_provider_model_override` | Function | `apps/desktop/src-tauri/src/claude.rs` | 667 |
| `stored_openai_compatible_credential_by_id` | Function | `apps/desktop/src-tauri/src/claude.rs` | 719 |
| `find_claude_in_registry_path` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1298 |
| `expand_env_vars` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1345 |
| `find_claude_binary` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1388 |
| `unix_claude_candidate_paths` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1573 |
| `clear_anthropic_provider_env` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2057 |
| `with_prompt_transport` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2080 |
| `common_claude_args` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2618 |
| `execute_openai_compatible_via_claude_proxy` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3083 |
| `execute_openai_compatible_provider` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3137 |
| `execute_openai_compatible_via_native_anthropic` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3173 |
| `apply_native_anthropic_provider_env` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3206 |
| `uses_native_anthropic_route` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3227 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Check_groq_cli_status → Strip_nul` | cross_community | 8 |
| `Ai_caption → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_caption → Restrict_auth_file_permissions` | cross_community | 6 |
| `Check_groq_cli_status → Get_claude_prism_auth_path` | cross_community | 6 |
| `Check_groq_cli_status → Restrict_auth_file_permissions` | cross_community | 6 |
| `Inline_transform_text → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_complete → Get_claude_prism_auth_path` | cross_community | 6 |
| `Login_claude → New` | cross_community | 5 |
| `Ai_complete_stream → Get_claude_prism_auth_path` | cross_community | 5 |
| `Ai_complete_stream → Restrict_auth_file_permissions` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_29 | 5 calls |
| Cursor_agent | 4 calls |
| Cluster_35 | 3 calls |
| Cluster_26 | 2 calls |
| Cluster_30 | 2 calls |
| Cluster_28 | 1 calls |
| Cluster_89 | 1 calls |
| Cluster_5 | 1 calls |

## How to Explore

1. `context({name: "spawn_claude_process"})` — see callers and callees
2. `query({search_query: "cluster_3"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
