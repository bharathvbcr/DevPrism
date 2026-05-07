---
name: cluster-40
description: "Skill for the Cluster_40 area of devprism-main. 11 symbols across 1 files."
---

# Cluster_40

11 symbols | 1 files | Cohesion: 92%

## When to Use

- Working with code in `apps/`
- Understanding how find_agent_cli_in_registry_path, expand_env_vars, find_agent_cli_binary work
- Modifying cluster_40-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/agent_runtime.rs` | find_agent_cli_in_registry_path, expand_env_vars, find_agent_cli_binary, unix_agent_cli_candidate_paths, unix_agent_cli_path_from_bin_dir (+6) |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `find_agent_cli_in_registry_path` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 111 |
| `expand_env_vars` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 158 |
| `find_agent_cli_binary` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 202 |
| `unix_agent_cli_candidate_paths` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 505 |
| `unix_agent_cli_path_from_bin_dir` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 530 |
| `unix_agent_cli_path_from_npm_prefix` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 535 |
| `run_login_shell_command` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 540 |
| `unix_shell_manager_candidate_paths` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 570 |
| `unix_known_pnpm_agent_cli_paths` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 597 |
| `test_unix_agent_cli_candidate_paths_include_pnpm_locations` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 3325 |
| `test_unix_known_pnpm_agent_cli_paths_include_known_layouts` | Function | `apps/desktop/src-tauri/src/agent_runtime.rs` | 3359 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Login_agent_cli → Run_login_shell_command` | cross_community | 4 |
| `Login_agent_cli → Unix_agent_cli_path_from_bin_dir` | cross_community | 4 |
| `Login_agent_cli → Unix_agent_cli_path_from_npm_prefix` | cross_community | 4 |
| `Login_agent_cli → Unix_known_pnpm_agent_cli_paths` | cross_community | 4 |
| `Login_agent_cli → Expand_env_vars` | cross_community | 4 |
| `Check_agent_cli_status → Run_login_shell_command` | cross_community | 4 |
| `Check_agent_cli_status → Unix_agent_cli_path_from_bin_dir` | cross_community | 4 |
| `Check_agent_cli_status → Unix_agent_cli_path_from_npm_prefix` | cross_community | 4 |
| `Check_agent_cli_status → Unix_known_pnpm_agent_cli_paths` | cross_community | 4 |
| `Check_agent_cli_status → Expand_env_vars` | cross_community | 4 |

## How to Explore

1. `gitnexus_context({name: "find_agent_cli_in_registry_path"})` — see callers and callees
2. `gitnexus_query({query: "cluster_40"})` — find related execution flows
3. Read key files listed above for implementation details
