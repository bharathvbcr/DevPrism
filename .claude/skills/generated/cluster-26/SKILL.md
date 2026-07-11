---
name: cluster-26
description: "Skill for the Cluster_26 area of DevPrism. 24 symbols across 2 files."
---

# Cluster_26

24 symbols | 2 files | Cohesion: 80%

## When to Use

- Working with code in `apps/`
- Understanding how persist_groq_api_key, save_anthropic_api_key, verify_openai_compatible_api_key work
- Modifying cluster_26-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/claude.rs` | normalize_api_key, normalize_optional_api_key, normalize_base_url, is_blocked_metadata_host, ensure_secure_known_provider_base_url (+17) |
| `apps/desktop/src-tauri/src/groq_setup.rs` | save_groq_api_key, verify_groq_api_key |

## Entry Points

Start here when exploring this area:

- **`persist_groq_api_key`** (Function) — `apps/desktop/src-tauri/src/claude.rs:769`
- **`save_anthropic_api_key`** (Function) — `apps/desktop/src-tauri/src/claude.rs:945`
- **`verify_openai_compatible_api_key`** (Function) — `apps/desktop/src-tauri/src/claude.rs:1049`
- **`list_openai_compatible_models`** (Function) — `apps/desktop/src-tauri/src/claude.rs:1079`
- **`list_openai_compatible_credential_models`** (Function) — `apps/desktop/src-tauri/src/claude.rs:1097`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `persist_groq_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 769 |
| `save_anthropic_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 945 |
| `verify_openai_compatible_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1049 |
| `list_openai_compatible_models` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1079 |
| `list_openai_compatible_credential_models` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1097 |
| `delete_openai_compatible_credential` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1204 |
| `save_groq_api_key` | Function | `apps/desktop/src-tauri/src/groq_setup.rs` | 147 |
| `verify_groq_api_key` | Function | `apps/desktop/src-tauri/src/groq_setup.rs` | 162 |
| `normalize_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 511 |
| `normalize_optional_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 524 |
| `normalize_base_url` | Function | `apps/desktop/src-tauri/src/claude.rs` | 533 |
| `is_blocked_metadata_host` | Function | `apps/desktop/src-tauri/src/claude.rs` | 571 |
| `ensure_secure_known_provider_base_url` | Function | `apps/desktop/src-tauri/src/claude.rs` | 580 |
| `normalize_provider` | Function | `apps/desktop/src-tauri/src/claude.rs` | 602 |
| `normalize_model` | Function | `apps/desktop/src-tauri/src/claude.rs` | 611 |
| `normalized_transformer_names` | Function | `apps/desktop/src-tauri/src/claude.rs` | 628 |
| `normalized_model_transformers` | Function | `apps/desktop/src-tauri/src/claude.rs` | 638 |
| `known_proxy_mismatch_error` | Function | `apps/desktop/src-tauri/src/claude.rs` | 679 |
| `normalized_openai_compatible_credentials` | Function | `apps/desktop/src-tauri/src/claude.rs` | 781 |
| `stored_openai_compatible_credential_from_config` | Function | `apps/desktop/src-tauri/src/claude.rs` | 849 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Check_groq_cli_status → Strip_nul` | cross_community | 8 |
| `Check_groq_cli_status → Is_blocked_metadata_host` | cross_community | 6 |
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
| Cursor_agent | 5 calls |
| Cluster_31 | 2 calls |
| Cluster_33 | 1 calls |
| Native_agent | 1 calls |
| Cluster_32 | 1 calls |

## How to Explore

1. `context({name: "persist_groq_api_key"})` — see callers and callees
2. `query({search_query: "cluster_26"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
