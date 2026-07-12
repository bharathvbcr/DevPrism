---
name: native-agent
description: "Skill for the Native_agent area of DevPrism. 209 symbols across 12 files."
---

# Native_agent

209 symbols | 12 files | Cohesion: 78%

## When to Use

- Working with code in `apps/`
- Understanding how spawn_claude_process, stored_openai_compatible_credential, extract_claude_print_result work
- Modifying native_agent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/native_agent/mod.rs` | ai_embed, is_retryable_chat_error, is_continue_nudge, normalize_rel, read_surrounding_lines (+67) |
| `apps/desktop/src-tauri/src/native_agent/tools.rs` | tool_schemas, schemas_are_well_formed, ask_user_schema_shape, execute, write_refuses_to_empty_an_existing_file (+41) |
| `apps/desktop/src-tauri/src/native_agent/ollama.rs` | first_installed_model, build_client, native_base, looks_like_embedding, installed_models (+27) |
| `apps/desktop/src-tauri/src/claude.rs` | is_claude_model_selector, normalize_provider_model_override, stored_openai_compatible_credential_by_id, stored_openai_compatible_credential, find_claude_in_registry_path (+23) |
| `apps/desktop/src-tauri/src/native_agent/openai_compat.rs` | build_client, provider_label, base_url_supports_embeddings, default_embedding_model, accumulate_openai_stream_line (+13) |
| `apps/desktop/src-tauri/src/google_auth.rs` | is_vertex_openai_compat_base_url, jwt_is_stale, should_mint_google_access_token, resolve_vertex_bearer_token |
| `apps/desktop/src-tauri/src/retry.rs` | is_retryable_status, backoff_delay, send_with_retry |
| `apps/desktop/src-tauri/src/personalization.rs` | augment_system_prompt, augment_system_prompt_appends_block |
| `apps/desktop/src-tauri/src/agent_process.rs` | spawn_claude_process |
| `apps/desktop/src-tauri/src/anthropic_proxy.rs` | start_openai_anthropic_proxy |

## Entry Points

Start here when exploring this area:

- **`spawn_claude_process`** (Function) — `apps/desktop/src-tauri/src/agent_process.rs:303`
- **`stored_openai_compatible_credential`** (Function) — `apps/desktop/src-tauri/src/claude.rs:727`
- **`extract_claude_print_result`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3275`
- **`complete_claude_print`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3313`
- **`execute_claude_code`** (Function) — `apps/desktop/src-tauri/src/claude.rs:3742`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `spawn_claude_process` | Function | `apps/desktop/src-tauri/src/agent_process.rs` | 303 |
| `stored_openai_compatible_credential` | Function | `apps/desktop/src-tauri/src/claude.rs` | 727 |
| `extract_claude_print_result` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3275 |
| `complete_claude_print` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3313 |
| `execute_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3742 |
| `continue_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3787 |
| `resume_claude_code` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3830 |
| `ai_embed` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1856 |
| `deliver_cached_native_reply` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 767 |
| `run_native_agent` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 791 |
| `stop_native_agent` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 2166 |
| `tool_schemas` | Function | `apps/desktop/src-tauri/src/native_agent/tools.rs` | 43 |
| `start_openai_anthropic_proxy` | Function | `apps/desktop/src-tauri/src/anthropic_proxy.rs` | 29 |
| `complete_openai_compatible_chat` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3222 |
| `complete_cursor_print` | Function | `apps/desktop/src-tauri/src/cursor_agent/stream_spawn.rs` | 158 |
| `inline_transform_text` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1641 |
| `ai_complete` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1685 |
| `ai_cancel_request` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1839 |
| `ai_complete_stream` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1906 |
| `ai_caption` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 2078 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Prepare_proxy_inference → Native_base` | cross_community | 8 |
| `Run_native_agent → Native_base` | cross_community | 7 |
| `Prepare_proxy_inference → Build_client` | cross_community | 7 |
| `Run_native_agent → Build_client` | cross_community | 6 |
| `Ai_caption → Native_base` | cross_community | 6 |
| `Ai_caption → Build_client` | cross_community | 6 |
| `Ai_caption → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_caption → Restrict_auth_file_permissions` | cross_community | 6 |
| `Ai_caption → Http_origin` | cross_community | 6 |
| `Ai_caption → Is_qwen_anthropic_origin` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cursor_agent | 13 calls |
| Cluster_40 | 6 calls |
| Cluster_42 | 5 calls |
| Cluster_36 | 2 calls |
| Cluster_41 | 2 calls |
| Cluster_99 | 2 calls |
| Cluster_2 | 2 calls |
| Cluster_96 | 1 calls |

## How to Explore

1. `context({name: "spawn_claude_process"})` — see callers and callees
2. `query({search_query: "native_agent"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
