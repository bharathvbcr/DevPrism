---
name: native-agent
description: "Skill for the Native_agent area of DevPrism. 109 symbols across 6 files."
---

# Native_agent

109 symbols | 6 files | Cohesion: 80%

## When to Use

- Working with code in `apps/`
- Understanding how tool_schemas, num_ctx, run_native_agent work
- Modifying native_agent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/native_agent/mod.rs` | is_continue_nudge, normalize_rel, read_surrounding_lines, read_small_file, cancels (+37) |
| `apps/desktop/src-tauri/src/native_agent/tools.rs` | tool_schemas, schemas_are_well_formed, arg, execute, write_refuses_to_empty_an_existing_file (+35) |
| `apps/desktop/src-tauri/src/native_agent/ollama.rs` | num_ctx, build_client, native_base, looks_like_embedding, installed_models (+17) |
| `apps/desktop/src-tauri/src/personalization.rs` | augment_system_prompt, augment_system_prompt_appends_block |
| `apps/desktop/src/hooks/use-claude-events.ts` | registerProposedChange, norm |
| `apps/desktop/src-tauri/src/claude.rs` | complete_openai_compatible_chat |

## Entry Points

Start here when exploring this area:

- **`tool_schemas`** (Function) — `apps/desktop/src-tauri/src/native_agent/tools.rs:35`
- **`num_ctx`** (Function) — `apps/desktop/src-tauri/src/native_agent/ollama.rs:354`
- **`run_native_agent`** (Function) — `apps/desktop/src-tauri/src/native_agent/mod.rs:454`
- **`stop_native_agent`** (Function) — `apps/desktop/src-tauri/src/native_agent/mod.rs:1267`
- **`native_base`** (Function) — `apps/desktop/src-tauri/src/native_agent/ollama.rs:125`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `tool_schemas` | Function | `apps/desktop/src-tauri/src/native_agent/tools.rs` | 35 |
| `num_ctx` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 354 |
| `run_native_agent` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 454 |
| `stop_native_agent` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1267 |
| `native_base` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 125 |
| `first_installed_model` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 197 |
| `first_embedding_model` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 211 |
| `server_status` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 245 |
| `list_models` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 294 |
| `new` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 327 |
| `embed` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 531 |
| `ai_embed` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1157 |
| `list_ollama_models` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1278 |
| `ollama_status` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1286 |
| `augment_system_prompt` | Function | `apps/desktop/src-tauri/src/personalization.rs` | 419 |
| `complete_openai_compatible_chat` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2895 |
| `with_json_format` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 347 |
| `chat` | Function | `apps/desktop/src-tauri/src/native_agent/ollama.rs` | 397 |
| `inline_transform_text` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1063 |
| `ai_complete` | Function | `apps/desktop/src-tauri/src/native_agent/mod.rs` | 1106 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Inline_transform_text → Profile_path` | cross_community | 6 |
| `Inline_transform_text → Default` | cross_community | 6 |
| `Inline_transform_text → Cmp` | cross_community | 6 |
| `Inline_transform_text → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_complete → Profile_path` | cross_community | 6 |
| `Ai_complete → Default` | cross_community | 6 |
| `Ai_complete → Cmp` | cross_community | 6 |
| `Ai_complete → Get_claude_prism_auth_path` | cross_community | 6 |
| `Run_native_agent → Build_client` | cross_community | 5 |
| `Ai_complete_stream → Identity_has_content` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_43 | 2 calls |
| Workspace | 2 calls |
| Cluster_66 | 2 calls |
| Preview | 2 calls |
| Cluster_42 | 1 calls |
| Cluster_76 | 1 calls |
| Cluster_197 | 1 calls |
| Cluster_38 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "tool_schemas"})` — see callers and callees
2. `gitnexus_query({query: "native_agent"})` — find related execution flows
3. Read key files listed above for implementation details
