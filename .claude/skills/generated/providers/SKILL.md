---
name: providers
description: "Skill for the Providers area of devprism-main. 28 symbols across 3 files."
---

# Providers

28 symbols | 3 files | Cohesion: 89%

## When to Use

- Working with code in `apps/`
- Understanding how execute_agent_code, continue_agent_code, resume_agent_code work
- Modifying providers-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/agent_runtime.rs` | gemini_cli_command_args, codex_cli_command_args, resolve_gemini_api_key, execute_native_agent, execute_gemini_cli (+12) |
| `apps/desktop/src-tauri/src/agent/providers/gemini.rs` | new, with_api_key, gemini_role, gemini_generate_url, chat_stream (+1) |
| `apps/desktop/src-tauri/src/agent/providers/ollama.rs` | with_base_url, model_likely_supports_tools, ollama_tool_capability_message, ollama_chat_url, chat |

## Entry Points

Start here when exploring this area:

- **`execute_agent_code`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:1940`
- **`continue_agent_code`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:1994`
- **`resume_agent_code`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:2084`
- **`get_agent_provider_settings`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:2581`
- **`check_gemini_api_status`** (Function) — `apps/desktop/src-tauri/src/agent_runtime.rs:2719`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `execute_agent_code` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 1940 |
| `continue_agent_code` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 1994 |
| `resume_agent_code` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 2084 |
| `get_agent_provider_settings` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 2581 |
| `check_gemini_api_status` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 2719 |
| `check_ollama_status` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 2743 |
| `with_base_url` | Function | `apps/desktop/src-tauri/src/agent/providers/ollama.rs` | 22 |
| `model_likely_supports_tools` | Function | `apps/desktop/src-tauri/src/agent/providers/ollama.rs` | 32 |
| `ollama_tool_capability_message` | Function | `apps/desktop/src-tauri/src/agent/providers/ollama.rs` | 48 |
| `new` | Function | `apps/desktop/src-tauri/src/agent/providers/gemini.rs` | 16 |
| `with_api_key` | Function | `apps/desktop/src-tauri/src/agent/providers/gemini.rs` | 22 |
| `gemini_role` | Function | `apps/desktop/src-tauri/src/agent/providers/gemini.rs` | 37 |
| `gemini_generate_url` | Function | `apps/desktop/src-tauri/src/agent/providers/gemini.rs` | 44 |
| `ollama_chat_url` | Function | `apps/desktop/src-tauri/src/agent/providers/ollama.rs` | 28 |
| `gemini_cli_command_args` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 458 |
| `codex_cli_command_args` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 467 |
| `resolve_gemini_api_key` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 485 |
| `execute_native_agent` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 1701 |
| `execute_gemini_cli` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 1805 |
| `execute_codex_cli` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 1872 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Execute_native_agent → Get_knowledge_dir` | cross_community | 6 |
| `Execute_native_agent → Init_feature_tables` | cross_community | 5 |
| `Execute_agent_code → Normalize_provider_name` | intra_community | 4 |
| `Execute_agent_code → Get_agent_settings_path` | cross_community | 4 |
| `Resume_agent_code → Normalize_provider_name` | intra_community | 4 |
| `Resume_agent_code → Get_agent_settings_path` | cross_community | 4 |
| `Continue_agent_code → Normalize_provider_name` | intra_community | 4 |
| `Continue_agent_code → Get_agent_settings_path` | cross_community | 4 |
| `Execute_native_agent → ProjectsFileContent` | cross_community | 4 |
| `Execute_agent_code → Find_gemini_binary` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Agent | 3 calls |
| Get_ | 3 calls |
| Cluster_41 | 2 calls |
| Knowledge | 1 calls |
| Cluster_43 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "execute_agent_code"})` — see callers and callees
2. `gitnexus_query({query: "providers"})` — find related execution flows
3. Read key files listed above for implementation details
