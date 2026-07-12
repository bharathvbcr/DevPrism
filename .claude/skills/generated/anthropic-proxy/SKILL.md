---
name: anthropic-proxy
description: "Skill for the Anthropic_proxy area of DevPrism. 112 symbols across 6 files."
---

# Anthropic_proxy

112 symbols | 6 files | Cohesion: 76%

## When to Use

- Working with code in `apps/`
- Understanding how openai_to_anthropic_message, repaired_tool_arguments_value, repair_tool_arguments work
- Modifying anthropic_proxy-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/anthropic_proxy/stream.rs` | exit_tool_response, openai_sse_event_to_anthropic, sse_event_data, openai_stream_chunk_to_anthropic, delta_text (+26) |
| `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | openai_to_anthropic_message, openai_message_text, openai_message_thinking, exit_tool_response, contains_only_exit_tool (+24) |
| `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | repaired_tool_arguments_value, repair_tool_arguments, push_candidate, parse_tool_arguments_candidate, trim_code_fence (+15) |
| `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | from_names, has, has_tooluse, has_cleancache, has_deepseek (+9) |
| `apps/desktop/src-tauri/src/anthropic_proxy/providers.rs` | apply_provider_request_transforms, cap_number_field, apply_reasoning_budget, apply_max_completion_tokens_compat, uses_max_completion_tokens (+8) |
| `apps/desktop/src-tauri/src/anthropic_proxy.rs` | converts_openai_tool_call_to_anthropic_message, http_response, converts_tool_use_and_tool_result_messages, keeps_tool_results_immediately_after_tool_calls, synthesizes_missing_tool_results_before_user_messages |

## Entry Points

Start here when exploring this area:

- **`openai_to_anthropic_message`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs:65`
- **`repaired_tool_arguments_value`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs:2`
- **`repair_tool_arguments`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs:15`
- **`normalized_tool_call_id`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs:6`
- **`apply_provider_request_transforms`** (Function) — `apps/desktop/src-tauri/src/anthropic_proxy/providers.rs:6`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `openai_to_anthropic_message` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | 65 |
| `repaired_tool_arguments_value` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 2 |
| `repair_tool_arguments` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 15 |
| `normalized_tool_call_id` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/tools.rs` | 6 |
| `apply_provider_request_transforms` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/providers.rs` | 6 |
| `from_names` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 63 |
| `stream_openai_sse_to_anthropic` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/stream.rs` | 31 |
| `sse_response` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/stream.rs` | 605 |
| `anthropic_to_openai_request` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | 7 |
| `has` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 40 |
| `has_tooluse` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 46 |
| `has_cleancache` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 50 |
| `has_deepseek` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 54 |
| `has_streamoptions` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 58 |
| `for_credential` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/transformers.rs` | 14 |
| `converts_openai_tool_call_to_anthropic_message` | Function | `apps/desktop/src-tauri/src/anthropic_proxy.rs` | 935 |
| `openai_message_text` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | 589 |
| `openai_message_thinking` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | 613 |
| `exit_tool_response` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | 634 |
| `contains_only_exit_tool` | Function | `apps/desktop/src-tauri/src/anthropic_proxy/messages.rs` | 647 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Handle_messages_to_stream → Has` | cross_community | 4 |
| `Handle_messages_to_stream → Is_deepseek_credential` | cross_community | 3 |
| `Handle_messages_to_stream → Configured_transformer_names` | cross_community | 3 |

## How to Explore

1. `context({name: "openai_to_anthropic_message"})` — see callers and callees
2. `query({search_query: "anthropic_proxy"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
