---
name: native-agent
description: "Skill for the Native_agent area of DevPrism. 154 symbols across 8 files."
---

# Native_agent

154 symbols | 8 files | Cohesion: 82%

## When to Use

- Working with code in `apps/`
- Understanding how deliver_cached_native_reply, run_native_agent, stop_native_agent work
- Modifying native_agent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/native_agent/mod.rs` | is_retryable_chat_error, is_continue_nudge, normalize_rel, read_small_file, cancels (+59) |
| `apps/desktop/src-tauri/src/native_agent/tools.rs` | tool_schemas, schemas_are_well_formed, ask_user_schema_shape, execute, write_refuses_to_empty_an_existing_file (+41) |
| `apps/desktop/src-tauri/src/native_agent/ollama.rs` | installed_model_names, first_installed_model, first_embedding_model, first_vision_model, build_client (+27) |
| `apps/desktop/src-tauri/src/native_agent/openai_compat.rs` | build_client, chat_completions_url, accumulate_openai_stream_line, new, chat (+1) |
| `apps/desktop/src-tauri/src/retry.rs` | is_retryable_status, backoff_delay, send_with_retry |
| `apps/desktop/src-tauri/src/claude.rs` | complete_openai_compatible_chat |
| `apps/desktop/src-tauri/src/personalization.rs` | augment_system_prompt |
| `apps/desktop/src-tauri/src/groq_setup.rs` | list_groq_models |

## Entry Points

Start here when exploring this area:

- **`deliver_cached_native_reply`** (Function) — `apps/desktop/src-tauri/src/native_agent/mod.rs:726`
- **`run_native_agent`** (Function) — `apps/desktop/src-tauri/src/native_agent/mod.rs:750`
- **`stop_native_agent`** (Function) — `apps/desktop/src-tauri/src/native_agent/mod.rs:1886`
- **`tool_schemas`** (Function) — `apps/desktop/src-tauri/src/native_agent/tools.rs:43`
- **`complete_openai_compatible_chat`** (Function) — `apps/desktop/src-tauri/src/claude.rs:2987`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `deliver_cached_native_reply` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 726 |
| `run_native_agent` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 750 |
| `stop_native_agent` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1886 |
| `tool_schemas` | Function | `apps/desktop/src-tauri/src/native_agent/tools.rs` | 43 |
| `complete_openai_compatible_chat` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2987 |
| `inline_transform_text` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1596 |
| `ai_complete` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1639 |
| `ai_embed` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1690 |
| `ai_complete_stream` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1723 |
| `ai_caption` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1802 |
| `first_installed_model` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 249 |
| `first_embedding_model` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 263 |
| `first_vision_model` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 284 |
| `augment_system_prompt` | Function | `apps/desktop/src-tauri/src/personalization.rs` | 419 |
| `list_ollama_models` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1897 |
| `ollama_status` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1905 |
| `ollama_ps` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1911 |
| `delete_ollama_model` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1919 |
| `copy_ollama_model` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1925 |
| `pull_ollama_model` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1944 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Prepare_proxy_inference → Native_base` | cross_community | 8 |
| `Store_proxy_cache → Native_base` | cross_community | 8 |
| `Run_native_agent → Native_base` | cross_community | 7 |
| `Prepare_proxy_inference → Build_client` | cross_community | 7 |
| `Store_proxy_cache → Build_client` | cross_community | 7 |
| `Run_native_agent → Build_client` | cross_community | 6 |
| `Ai_caption → Native_base` | cross_community | 6 |
| `Ai_caption → Build_client` | cross_community | 6 |
| `Ai_caption → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_caption → Restrict_auth_file_permissions` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cursor_agent | 6 calls |
| Cluster_3 | 1 calls |
| Cluster_31 | 1 calls |
| Cluster_59 | 1 calls |
| Anthropic_proxy | 1 calls |
| Cluster_2 | 1 calls |
| Cluster_89 | 1 calls |

## How to Explore

1. `context({name: "deliver_cached_native_reply"})` — see callers and callees
2. `query({search_query: "native_agent"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
