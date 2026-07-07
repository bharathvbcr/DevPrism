---
name: cluster-54
description: "Skill for the Cluster_54 area of DevPrism. 37 symbols across 1 files."
---

# Cluster_54

37 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `apps/`
- Understanding how history_init, history_snapshot, history_list work
- Modifying cluster_54-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/history.rs` | history_path, open_repo, default_signature, tag_map, ensure_excludes (+32) |

## Entry Points

Start here when exploring this area:

- **`history_init`** (Function) — `apps/desktop/src-tauri/src/history.rs:117`
- **`history_snapshot`** (Function) — `apps/desktop/src-tauri/src/history.rs:180`
- **`history_list`** (Function) — `apps/desktop/src-tauri/src/history.rs:266`
- **`history_diff`** (Function) — `apps/desktop/src-tauri/src/history.rs:342`
- **`history_file_at`** (Function) — `apps/desktop/src-tauri/src/history.rs:424`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `history_init` | Function | `apps/desktop/src-tauri/src/history.rs` | 117 |
| `history_snapshot` | Function | `apps/desktop/src-tauri/src/history.rs` | 180 |
| `history_list` | Function | `apps/desktop/src-tauri/src/history.rs` | 266 |
| `history_diff` | Function | `apps/desktop/src-tauri/src/history.rs` | 342 |
| `history_file_at` | Function | `apps/desktop/src-tauri/src/history.rs` | 424 |
| `history_restore` | Function | `apps/desktop/src-tauri/src/history.rs` | 450 |
| `history_add_label` | Function | `apps/desktop/src-tauri/src/history.rs` | 499 |
| `history_remove_label` | Function | `apps/desktop/src-tauri/src/history.rs` | 517 |
| `history_path` | Function | `apps/desktop/src-tauri/src/history.rs` | 27 |
| `open_repo` | Function | `apps/desktop/src-tauri/src/history.rs` | 33 |
| `default_signature` | Function | `apps/desktop/src-tauri/src/history.rs` | 38 |
| `tag_map` | Function | `apps/desktop/src-tauri/src/history.rs` | 44 |
| `ensure_excludes` | Function | `apps/desktop/src-tauri/src/history.rs` | 60 |
| `setup_project` | Function | `apps/desktop/src-tauri/src/history.rs` | 534 |
| `root` | Function | `apps/desktop/src-tauri/src/history.rs` | 546 |
| `test_history_init_creates_repo` | Function | `apps/desktop/src-tauri/src/history.rs` | 553 |
| `test_history_init_idempotent` | Function | `apps/desktop/src-tauri/src/history.rs` | 568 |
| `test_history_init_creates_excludes` | Function | `apps/desktop/src-tauri/src/history.rs` | 577 |
| `test_history_snapshot_after_modification` | Function | `apps/desktop/src-tauri/src/history.rs` | 592 |
| `test_history_snapshot_no_change_returns_none` | Function | `apps/desktop/src-tauri/src/history.rs` | 608 |

## How to Explore

1. `context({name: "history_init"})` — see callers and callees
2. `query({search_query: "cluster_54"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
