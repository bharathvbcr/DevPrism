---
name: cluster-24
description: "Skill for the Cluster_24 area of DevPrism. 20 symbols across 1 files."
---

# Cluster_24

20 symbols | 1 files | Cohesion: 79%

## When to Use

- Working with code in `apps/`
- Understanding how save_anthropic_api_key, verify_openai_compatible_api_key, list_openai_compatible_models work
- Modifying cluster_24-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/claude.rs` | normalize_api_key, normalize_optional_api_key, normalize_base_url, is_blocked_metadata_host, ensure_secure_known_provider_base_url (+15) |

## Entry Points

Start here when exploring this area:

- **`save_anthropic_api_key`** (Function) — `apps/desktop/src-tauri/src/claude.rs:888`
- **`verify_openai_compatible_api_key`** (Function) — `apps/desktop/src-tauri/src/claude.rs:992`
- **`list_openai_compatible_models`** (Function) — `apps/desktop/src-tauri/src/claude.rs:1022`
- **`delete_openai_compatible_credential`** (Function) — `apps/desktop/src-tauri/src/claude.rs:1147`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `save_anthropic_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 888 |
| `verify_openai_compatible_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 992 |
| `list_openai_compatible_models` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1022 |
| `delete_openai_compatible_credential` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1147 |
| `normalize_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 509 |
| `normalize_optional_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 522 |
| `normalize_base_url` | Function | `apps/desktop/src-tauri/src/claude.rs` | 531 |
| `is_blocked_metadata_host` | Function | `apps/desktop/src-tauri/src/claude.rs` | 569 |
| `ensure_secure_known_provider_base_url` | Function | `apps/desktop/src-tauri/src/claude.rs` | 578 |
| `normalize_provider` | Function | `apps/desktop/src-tauri/src/claude.rs` | 600 |
| `normalize_model` | Function | `apps/desktop/src-tauri/src/claude.rs` | 609 |
| `normalized_transformer_names` | Function | `apps/desktop/src-tauri/src/claude.rs` | 626 |
| `normalized_model_transformers` | Function | `apps/desktop/src-tauri/src/claude.rs` | 636 |
| `known_proxy_mismatch_error` | Function | `apps/desktop/src-tauri/src/claude.rs` | 677 |
| `normalized_openai_compatible_credentials` | Function | `apps/desktop/src-tauri/src/claude.rs` | 724 |
| `stored_openai_compatible_credential_from_config` | Function | `apps/desktop/src-tauri/src/claude.rs` | 792 |
| `fetch_openai_compatible_models` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1052 |
| `strip_nul` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1715 |
| `test_known_proxy_mismatch_rejects_modelgate_codex_proxy` | Function | `apps/desktop/src-tauri/src/claude.rs` | 4666 |
| `test_known_proxy_mismatch_rejects_claude_proxy_as_openai_compatible` | Function | `apps/desktop/src-tauri/src/claude.rs` | 4679 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Run_shell_command → Strip_nul` | cross_community | 6 |
| `Run_shell_command → Is_blocked_metadata_host` | cross_community | 6 |
| `Check_claude_status → Strip_nul` | cross_community | 5 |
| `Check_claude_status → Is_blocked_metadata_host` | cross_community | 5 |
| `Execute_claude_code → Strip_nul` | cross_community | 4 |
| `Continue_claude_code → Strip_nul` | cross_community | 4 |
| `Resume_claude_code → Strip_nul` | cross_community | 4 |
| `Delete_openai_compatible_credential → Get_claude_prism_auth_path` | cross_community | 4 |
| `Delete_openai_compatible_credential → Restrict_auth_file_permissions` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_23 | 4 calls |
| Cluster_30 | 2 calls |
| Cluster_32 | 1 calls |
| Native_agent | 1 calls |
| Cluster_31 | 1 calls |

## How to Explore

1. `context({name: "save_anthropic_api_key"})` — see callers and callees
2. `query({search_query: "cluster_24"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
