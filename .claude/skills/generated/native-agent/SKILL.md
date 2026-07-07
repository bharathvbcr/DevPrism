---
name: native-agent
description: "Skill for the Native_agent area of DevPrism. 141 symbols across 6 files."
---

# Native_agent

141 symbols | 6 files | Cohesion: 82%

## When to Use

- Working with code in `apps/`
- Understanding how deliver_cached_native_reply, run_native_agent, stop_native_agent work
- Modifying native_agent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/native_agent/mod.rs` | is_retryable_chat_error, is_continue_nudge, normalize_rel, read_surrounding_lines, read_small_file (+53) |
| `apps/desktop/src-tauri/src/native_agent/tools.rs` | tool_schemas, schemas_are_well_formed, ask_user_schema_shape, resolve, canonicalize_existing (+44) |
| `apps/desktop/src-tauri/src/native_agent/ollama.rs` | first_installed_model, looks_like_embedding, installed_models, installed_model_names, first_embedding_model (+23) |
| `apps/desktop/src-tauri/src/retry.rs` | is_retryable_status, backoff_delay, send_with_retry |
| `apps/desktop/src-tauri/src/personalization.rs` | augment_system_prompt, augment_system_prompt_appends_block |
| `apps/desktop/src-tauri/src/claude.rs` | complete_openai_compatible_chat |

## Entry Points

Start here when exploring this area:

- **`deliver_cached_native_reply`** (Function) — `apps/desktop/src-tauri/src/native_agent/mod.rs:625`
- **`run_native_agent`** (Function) — `apps/desktop/src-tauri/src/native_agent/mod.rs:649`
- **`stop_native_agent`** (Function) — `apps/desktop/src-tauri/src/native_agent/mod.rs:1646`
- **`tool_schemas`** (Function) — `apps/desktop/src-tauri/src/native_agent/tools.rs:43`
- **`complete_openai_compatible_chat`** (Function) — `apps/desktop/src-tauri/src/claude.rs:2930`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `deliver_cached_native_reply` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 625 |
| `run_native_agent` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 649 |
| `stop_native_agent` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1646 |
| `tool_schemas` | Function | `apps/desktop/src-tauri/src/native_agent/tools.rs` | 43 |
| `complete_openai_compatible_chat` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2930 |
| `inline_transform_text` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1356 |
| `ai_complete` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1399 |
| `ai_complete_stream` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1483 |
| `ai_caption` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1562 |
| `first_installed_model` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 218 |
| `augment_system_prompt` | Function | `apps/desktop/src-tauri/src/personalization.rs` | 419 |
| `ai_embed` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1450 |
| `list_ollama_models` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1657 |
| `ollama_status` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1665 |
| `first_embedding_model` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 232 |
| `first_vision_model` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 253 |
| `server_status` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 290 |
| `list_models` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 335 |
| `ollama_ps` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1671 |
| `delete_ollama_model` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1679 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Prepare_proxy_inference → Native_base` | cross_community | 8 |
| `Store_proxy_cache → Native_base` | cross_community | 8 |
| `Run_native_agent → Native_base` | cross_community | 7 |
| `Prepare_proxy_inference → Build_client` | cross_community | 7 |
| `Store_proxy_cache → Build_client` | cross_community | 7 |
| `Run_native_agent → Build_client` | cross_community | 6 |
| `Inline_transform_text → Profile_path` | cross_community | 6 |
| `Inline_transform_text → Default` | cross_community | 6 |
| `Inline_transform_text → Get_claude_prism_auth_path` | cross_community | 6 |
| `Inline_transform_text → Restrict_auth_file_permissions` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_88 | 2 calls |
| Cluster_1 | 2 calls |
| Cluster_87 | 1 calls |
| Cluster_90 | 1 calls |
| Cluster_30 | 1 calls |
| Cluster_57 | 1 calls |
| Anthropic_proxy | 1 calls |
| Cluster_91 | 1 calls |

## How to Explore

1. `context({name: "deliver_cached_native_reply"})` — see callers and callees
2. `query({search_query: "native_agent"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
