---
name: cursor-agent
description: "Skill for the Cursor_agent area of DevPrism. 104 symbols across 14 files."
---

# Cursor_agent

104 symbols | 14 files | Cohesion: 75%

## When to Use

- Working with code in `apps/`
- Understanding how stop_agent_process, stop_claude_process, is_essential_env_var work
- Modifying cursor_agent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/claude.rs` | is_essential_env_var, strip_ansi, sanitize_appimage_env, resolve_cmd_to_node, new_sync_command (+26) |
| `apps/desktop/src-tauri/src/cursor_agent/acp_client.rs` | new, emit_output, emit_complete, write_line, request (+13) |
| `apps/desktop/src-tauri/src/cursor_agent/stream_adapter.rs` | adapt_cursor_line, adapt_assistant, adapt_tool_call, adapt_tool_result, adapts_assistant_text_delta (+3) |
| `apps/desktop/src-tauri/src/cursor_agent/setup.rs` | find_agent_binary, stored_cursor_api_key, cursor_authenticated, check_cursor_cli_status, install_cursor_cli (+2) |
| `apps/desktop/src-tauri/src/cursor_agent/stream_spawn.rs` | cursor_system_prompt, build_stream_command, run_cursor_agent, execute_cursor_agent, resume_cursor_agent (+1) |
| `apps/desktop/src-tauri/src/lib.rs` | detect_editors, is_editor_installed, open_in_editor, resolve_editor_cli, get_system_info (+1) |
| `apps/desktop/src-tauri/src/agent_process.rs` | default, stop_agent_process, stop_claude_process, interrupt_or_terminate, terminate_process_tree |
| `apps/desktop/src-tauri/src/slash_commands.rs` | extract_command_info, test_extract_command_info_simple, test_extract_command_info_nested, test_extract_command_info_deeply_nested, test_extract_command_info_strips_extension |
| `apps/desktop/src-tauri/src/groq_setup.rs` | find_groq_binary, check_groq_cli_status, install_groq_cli, groq_api_key_configured |
| `apps/desktop/src-tauri/src/native_agent/tools.rs` | resolve, canonicalize_existing, strip_project_prefix, resolve_blocks_traversal |

## Entry Points

Start here when exploring this area:

- **`stop_agent_process`** (Function) — `apps/desktop/src-tauri/src/agent_process.rs:322`
- **`stop_claude_process`** (Function) — `apps/desktop/src-tauri/src/agent_process.rs:355`
- **`is_essential_env_var`** (Function) — `apps/desktop/src-tauri/src/claude.rs:89`
- **`install_claude_cli`** (Function) — `apps/desktop/src-tauri/src/claude.rs:2390`
- **`login_claude`** (Function) — `apps/desktop/src-tauri/src/claude.rs:2509`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `stop_agent_process` | Function | `apps/desktop/src-tauri/src/agent_process.rs` | 322 |
| `stop_claude_process` | Function | `apps/desktop/src-tauri/src/agent_process.rs` | 355 |
| `is_essential_env_var` | Function | `apps/desktop/src-tauri/src/claude.rs` | 89 |
| `install_claude_cli` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2390 |
| `login_claude` | Function | `apps/desktop/src-tauri/src/claude.rs` | 2509 |
| `cancel_claude_execution` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3469 |
| `interrupt_claude_execution` | Function | `apps/desktop/src-tauri/src/claude.rs` | 3476 |
| `find_agent_binary` | Function | `apps/desktop/src-tauri/src/cursor_agent/setup.rs` | 15 |
| `stored_cursor_api_key` | Function | `apps/desktop/src-tauri/src/cursor_agent/setup.rs` | 33 |
| `check_cursor_cli_status` | Function | `apps/desktop/src-tauri/src/cursor_agent/setup.rs` | 57 |
| `install_cursor_cli` | Function | `apps/desktop/src-tauri/src/cursor_agent/setup.rs` | 89 |
| `login_cursor_cli` | Function | `apps/desktop/src-tauri/src/cursor_agent/setup.rs` | 149 |
| `execute_cursor_agent` | Function | `apps/desktop/src-tauri/src/cursor_agent/stream_spawn.rs` | 110 |
| `resume_cursor_agent` | Function | `apps/desktop/src-tauri/src/cursor_agent/stream_spawn.rs` | 129 |
| `export_document` | Function | `apps/desktop/src-tauri/src/export.rs` | 98 |
| `check_groq_cli_status` | Function | `apps/desktop/src-tauri/src/groq_setup.rs` | 59 |
| `install_groq_cli` | Function | `apps/desktop/src-tauri/src/groq_setup.rs` | 86 |
| `build_personalization_prompt` | Function | `apps/desktop/src-tauri/src/personalization.rs` | 287 |
| `get_personalization_profile` | Function | `apps/desktop/src-tauri/src/personalization.rs` | 471 |
| `install_uv` | Function | `apps/desktop/src-tauri/src/uv.rs` | 259 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Check_groq_cli_status → Strip_nul` | cross_community | 8 |
| `Ai_caption → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_caption → Restrict_auth_file_permissions` | cross_community | 6 |
| `Check_groq_cli_status → Get_claude_prism_auth_path` | cross_community | 6 |
| `Check_groq_cli_status → Restrict_auth_file_permissions` | cross_community | 6 |
| `Check_groq_cli_status → Is_blocked_metadata_host` | cross_community | 6 |
| `Inline_transform_text → Profile_path` | cross_community | 6 |
| `Inline_transform_text → Default` | cross_community | 6 |
| `Inline_transform_text → Get_claude_prism_auth_path` | cross_community | 6 |
| `Ai_complete → Profile_path` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_26 | 4 calls |
| Cluster_24 | 2 calls |
| Cluster_3 | 2 calls |
| Cluster_2 | 2 calls |
| Cluster_86 | 1 calls |
| Cluster_88 | 1 calls |
| Cluster_89 | 1 calls |

## How to Explore

1. `context({name: "stop_agent_process"})` — see callers and callees
2. `query({search_query: "cursor_agent"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
