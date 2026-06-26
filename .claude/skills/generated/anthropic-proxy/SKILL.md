---
name: anthropic-proxy
description: "Skill for the Anthropic_proxy area of DevPrism. 107 symbols across 6 files."
---

# Anthropic_proxy

107 symbols | 6 files | Cohesion: 73%

## When to Use

- Working with code in `apps/`
- Understanding how repair_tool_arguments, repaired_tool_arguments_value, normalized_tool_call_id work
- Modifying anthropic_proxy-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | openai_to_anthropic_message, openai_message_text, openai_message_thinking, exit_tool_response, contains_only_exit_tool (+24) |
| `apps/desktop/src-tauri/src/anthropic_proxy/stream.rs` | exit_tool_response, openai_sse_event_to_anthropic, sse_event_data, openai_stream_chunk_to_anthropic, delta_text (+23) |
| `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | repair_tool_arguments, push_candidate, parse_tool_arguments_candidate, trim_code_fence, extract_json_like (+15) |
| `apps/desktop/src-tauri/src/anthropic_proxy/providers.rs` | apply_provider_request_transforms, cap_number_field, apply_reasoning_budget, apply_max_completion_tokens_compat, uses_max_completion_tokens (+8) |
| `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | has_cleancache, has_deepseek, has_streamoptions, for_credential, configured_transformer_names (+7) |
| `apps/desktop/src-tauri/src/anthropic_proxy.rs` | converts_openai_tool_call_to_anthropic_message, http_response, converts_tool_use_and_tool_result_messages, keeps_tool_results_immediately_after_tool_calls, synthesizes_missing_tool_results_before_user_messages |

## Entry Points

Start here when exploring this area:

- **`repair_tool_arguments`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs:15`
- **`repaired_tool_arguments_value`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs:2`
- **`normalized_tool_call_id`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs:6`
- **`openai_to_anthropic_message`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs:65`
- **`has_cleancache`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs:50`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `repair_tool_arguments` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 15 |
| `repaired_tool_arguments_value` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 2 |
| `normalized_tool_call_id` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 6 |
| `openai_to_anthropic_message` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | 65 |
| `has_cleancache` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 50 |
| `has_deepseek` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 54 |
| `has_streamoptions` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 58 |
| `apply_provider_request_transforms` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/providers.rs` | 6 |
| `sse_response` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/stream.rs` | 545 |
| `for_credential` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 14 |
| `has_tooluse` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 46 |
| `anthropic_to_openai_request` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | 7 |
| `stream_openai_sse_to_anthropic` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/stream.rs` | 28 |
| `from_names` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 63 |
| `push_candidate` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 62 |
| `parse_tool_arguments_candidate` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 70 |
| `trim_code_fence` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 90 |
| `extract_json_like` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 105 |
| `repair_balanced_json` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 121 |
| `remove_trailing_commas` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 162 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Handle_messages_to_stream → Anthropic_image_block_to_openai_part` | cross_community | 5 |
| `Handle_connection → Assistant_content_to_openai` | cross_community | 5 |
| `Handle_connection → Openai_message_role` | cross_community | 5 |
| `Handle_connection → Has` | cross_community | 5 |
| `Handle_messages_to_stream → Has` | cross_community | 4 |
| `Route_request → Http_response` | cross_community | 4 |
| `Handle_connection → Is_deepseek_credential` | cross_community | 4 |
| `Handle_connection → Configured_transformer_names` | cross_community | 4 |
| `Handle_connection → Copy_number_field` | cross_community | 4 |
| `Handle_connection → Clean_cache_control` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Editor | 4 calls |
| Preview | 1 calls |

## How to Explore

1. `gitnexus_context({name: "repair_tool_arguments"})` — see callers and callees
2. `gitnexus_query({query: "anthropic_proxy"})` — find related execution flows
3. Read key files listed above for implementation details
