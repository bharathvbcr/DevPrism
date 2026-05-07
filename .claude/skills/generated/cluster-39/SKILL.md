---
name: cluster-39
description: "Skill for the Cluster_39 area of devprism-main. 37 symbols across 1 files."
---

# Cluster_39

37 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `apps/`
- Understanding how history_init, history_snapshot, history_list work
- Modifying cluster_39-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/history.rs` | history_path, open_repo, default_signature, tag_map, ensure_excludes (+32) |

## Entry Points

Start here when exploring this area:

- **`history_init`** (Function) — `apps/desktop/src-tauri/src/history.rs:115`
- **`history_snapshot`** (Function) — `apps/desktop/src-tauri/src/history.rs:178`
- **`history_list`** (Function) — `apps/desktop/src-tauri/src/history.rs:264`
- **`history_diff`** (Function) — `apps/desktop/src-tauri/src/history.rs:340`
- **`history_file_at`** (Function) — `apps/desktop/src-tauri/src/history.rs:422`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `history_init` | Function | `apps/desktop/src-tauri/src/history.rs` | 115 |
| `history_snapshot` | Function | `apps/desktop/src-tauri/src/history.rs` | 178 |
| `history_list` | Function | `apps/desktop/src-tauri/src/history.rs` | 264 |
| `history_diff` | Function | `apps/desktop/src-tauri/src/history.rs` | 340 |
| `history_file_at` | Function | `apps/desktop/src-tauri/src/history.rs` | 422 |
| `history_restore` | Function | `apps/desktop/src-tauri/src/history.rs` | 448 |
| `history_add_label` | Function | `apps/desktop/src-tauri/src/history.rs` | 497 |
| `history_remove_label` | Function | `apps/desktop/src-tauri/src/history.rs` | 515 |
| `history_path` | Function | `apps/desktop/src-tauri/src/history.rs` | 27 |
| `open_repo` | Function | `apps/desktop/src-tauri/src/history.rs` | 33 |
| `default_signature` | Function | `apps/desktop/src-tauri/src/history.rs` | 38 |
| `tag_map` | Function | `apps/desktop/src-tauri/src/history.rs` | 44 |
| `ensure_excludes` | Function | `apps/desktop/src-tauri/src/history.rs` | 60 |
| `setup_project` | Function | `apps/desktop/src-tauri/src/history.rs` | 532 |
| `root` | Function | `apps/desktop/src-tauri/src/history.rs` | 544 |
| `test_history_init_creates_repo` | Function | `apps/desktop/src-tauri/src/history.rs` | 551 |
| `test_history_init_idempotent` | Function | `apps/desktop/src-tauri/src/history.rs` | 566 |
| `test_history_init_creates_excludes` | Function | `apps/desktop/src-tauri/src/history.rs` | 575 |
| `test_history_snapshot_after_modification` | Function | `apps/desktop/src-tauri/src/history.rs` | 590 |
| `test_history_snapshot_no_change_returns_none` | Function | `apps/desktop/src-tauri/src/history.rs` | 606 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Test_tag_map_groups_by_oid → History_path` | intra_community | 4 |
| `Test_history_diff_shows_changes → History_path` | intra_community | 4 |
| `Test_history_diff_added_file → History_path` | intra_community | 4 |
| `Test_history_restore_reverts_content → History_path` | intra_community | 4 |
| `Test_history_add_and_remove_label → History_path` | intra_community | 4 |
| `Test_history_diff_deleted_file → History_path` | intra_community | 4 |
| `Test_history_diff_nonadjacent_snapshots → History_path` | intra_community | 4 |
| `Test_history_restore_creates_restore_commit → History_path` | intra_community | 4 |
| `Test_history_list_after_snapshots → History_path` | intra_community | 4 |
| `Test_history_list_pagination → History_path` | intra_community | 4 |

## How to Explore

1. `gitnexus_context({name: "history_init"})` — see callers and callees
2. `gitnexus_query({query: "cluster_39"})` — find related execution flows
3. Read key files listed above for implementation details
