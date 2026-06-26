---
name: cluster-70
description: "Skill for the Cluster_70 area of DevPrism. 19 symbols across 1 files."
---

# Cluster_70

19 symbols | 1 files | Cohesion: 79%

## When to Use

- Working with code in `apps/`
- Understanding how save_anthropic_api_key, verify_openai_compatible_api_key, list_openai_compatible_models work
- Modifying cluster_70-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/claude.rs` | normalize_api_key, normalize_optional_api_key, normalize_base_url, ensure_secure_known_provider_base_url, normalize_provider (+14) |

## Entry Points

Start here when exploring this area:

- **`save_anthropic_api_key`** (Function) — `apps/desktop/src-tauri/src/claude.rs:862`
- **`verify_openai_compatible_api_key`** (Function) — `apps/desktop/src-tauri/src/claude.rs:966`
- **`list_openai_compatible_models`** (Function) — `apps/desktop/src-tauri/src/claude.rs:996`
- **`delete_openai_compatible_credential`** (Function) — `apps/desktop/src-tauri/src/claude.rs:1112`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `save_anthropic_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 862 |
| `verify_openai_compatible_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 966 |
| `list_openai_compatible_models` | Function | `apps/desktop/src-tauri/src/claude.rs` | 996 |
| `delete_openai_compatible_credential` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1112 |
| `normalize_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 509 |
| `normalize_optional_api_key` | Function | `apps/desktop/src-tauri/src/claude.rs` | 522 |
| `normalize_base_url` | Function | `apps/desktop/src-tauri/src/claude.rs` | 531 |
| `ensure_secure_known_provider_base_url` | Function | `apps/desktop/src-tauri/src/claude.rs` | 552 |
| `normalize_provider` | Function | `apps/desktop/src-tauri/src/claude.rs` | 574 |
| `normalize_model` | Function | `apps/desktop/src-tauri/src/claude.rs` | 583 |
| `normalized_transformer_names` | Function | `apps/desktop/src-tauri/src/claude.rs` | 600 |
| `normalized_model_transformers` | Function | `apps/desktop/src-tauri/src/claude.rs` | 610 |
| `known_proxy_mismatch_error` | Function | `apps/desktop/src-tauri/src/claude.rs` | 651 |
| `normalized_openai_compatible_credentials` | Function | `apps/desktop/src-tauri/src/claude.rs` | 698 |
| `stored_openai_compatible_credential_from_config` | Function | `apps/desktop/src-tauri/src/claude.rs` | 766 |
| `fetch_openai_compatible_models` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1026 |
| `strip_nul` | Function | `apps/desktop/src-tauri/src/claude.rs` | 1680 |
| `test_known_proxy_mismatch_rejects_modelgate_codex_proxy` | Function | `apps/desktop/src-tauri/src/claude.rs` | 4606 |
| `test_known_proxy_mismatch_rejects_claude_proxy_as_openai_compatible` | Function | `apps/desktop/src-tauri/src/claude.rs` | 4619 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Run_shell_command → Strip_nul` | cross_community | 6 |
| `Check_claude_status → Strip_nul` | cross_community | 5 |
| `List_openai_compatible_credential_models → Http_origin` | cross_community | 5 |
| `Execute_claude_code → Strip_nul` | cross_community | 4 |
| `Continue_claude_code → Strip_nul` | cross_community | 4 |
| `Resume_claude_code → Strip_nul` | cross_community | 4 |
| `Delete_openai_compatible_credential → Get_claude_prism_auth_path` | cross_community | 4 |
| `Delete_openai_compatible_credential → Restrict_auth_file_permissions` | cross_community | 4 |
| `List_openai_compatible_credential_models → Strip_nul` | cross_community | 4 |
| `List_openai_compatible_credential_models → Openai_compatible_base_url_has_chat_root` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_69 | 4 calls |
| Cluster_76 | 2 calls |
| Cluster_78 | 1 calls |
| Cluster_77 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "save_anthropic_api_key"})` — see callers and callees
2. `gitnexus_query({query: "cluster_70"})` — find related execution flows
3. Read key files listed above for implementation details
