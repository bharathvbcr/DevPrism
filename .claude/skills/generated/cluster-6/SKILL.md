---
name: cluster-6
description: "Skill for the Cluster_6 area of devprism-main. 14 symbols across 1 files."
---

# Cluster_6

14 symbols | 1 files | Cohesion: 92%

## When to Use

- Working with code in `apps/`
- Understanding how zotero_start_oauth work
- Modifying cluster_6-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/zotero.rs` | consumer_key, consumer_secret, generate_nonce, get_timestamp, hmac_sha1 (+9) |

## Entry Points

Start here when exploring this area:

- **`zotero_start_oauth`** (Function) — `apps/desktop/src-tauri/src/zotero.rs:320`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `zotero_start_oauth` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 320 |
| `consumer_key` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 14 |
| `consumer_secret` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 19 |
| `generate_nonce` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 69 |
| `get_timestamp` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 77 |
| `hmac_sha1` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 85 |
| `oauth_signature` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 92 |
| `build_auth_header` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 124 |
| `request_token` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 146 |
| `access_token` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 255 |
| `test_hmac_sha1_known_vector` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 402 |
| `test_oauth_signature_produces_base64` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 414 |
| `test_oauth_signature_deterministic` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 440 |
| `test_build_auth_header_format` | Function | `apps/desktop/src-tauri/src/zotero.rs` | 451 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Zotero_start_oauth → Consumer_key` | intra_community | 3 |
| `Zotero_start_oauth → Consumer_secret` | intra_community | 3 |
| `Zotero_start_oauth → Generate_nonce` | intra_community | 3 |
| `Zotero_start_oauth → Get_timestamp` | intra_community | 3 |
| `Zotero_complete_oauth → Consumer_key` | cross_community | 3 |
| `Zotero_complete_oauth → Consumer_secret` | cross_community | 3 |
| `Zotero_complete_oauth → Generate_nonce` | cross_community | 3 |
| `Zotero_complete_oauth → Get_timestamp` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_7 | 2 calls |

## How to Explore

1. `gitnexus_context({name: "zotero_start_oauth"})` — see callers and callees
2. `gitnexus_query({query: "cluster_6"})` — find related execution flows
3. Read key files listed above for implementation details
