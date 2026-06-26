---
name: cluster-64
description: "Skill for the Cluster_64 area of DevPrism. 14 symbols across 1 files."
---

# Cluster_64

14 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `apps/`
- Understanding how comments_list, comments_add, comments_update work
- Modifying cluster_64-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/comments.rs` | comments_path, notifications_path, read_file_or_default, atomic_write, append_notification (+9) |

## Entry Points

Start here when exploring this area:

- **`comments_list`** (Function) — `apps/desktop/src-tauri/src/comments.rs:136`
- **`comments_add`** (Function) — `apps/desktop/src-tauri/src/comments.rs:154`
- **`comments_update`** (Function) — `apps/desktop/src-tauri/src/comments.rs:197`
- **`comments_reply`** (Function) — `apps/desktop/src-tauri/src/comments.rs:259`
- **`comments_start_watcher`** (Function) — `apps/desktop/src-tauri/src/comments.rs:300`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `comments_list` | Function | `apps/desktop/src-tauri/src/comments.rs` | 136 |
| `comments_add` | Function | `apps/desktop/src-tauri/src/comments.rs` | 154 |
| `comments_update` | Function | `apps/desktop/src-tauri/src/comments.rs` | 197 |
| `comments_reply` | Function | `apps/desktop/src-tauri/src/comments.rs` | 259 |
| `comments_start_watcher` | Function | `apps/desktop/src-tauri/src/comments.rs` | 300 |
| `comments_path` | Function | `apps/desktop/src-tauri/src/comments.rs` | 60 |
| `notifications_path` | Function | `apps/desktop/src-tauri/src/comments.rs` | 64 |
| `read_file_or_default` | Function | `apps/desktop/src-tauri/src/comments.rs` | 70 |
| `atomic_write` | Function | `apps/desktop/src-tauri/src/comments.rs` | 82 |
| `append_notification` | Function | `apps/desktop/src-tauri/src/comments.rs` | 103 |
| `now_iso` | Function | `apps/desktop/src-tauri/src/comments.rs` | 117 |
| `gen_id` | Function | `apps/desktop/src-tauri/src/comments.rs` | 121 |
| `write_all` | Function | `apps/desktop/src-tauri/src/comments.rs` | 127 |
| `default` | Function | `apps/desktop/src-tauri/src/comments.rs` | 294 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Comments_add → Comments_path` | intra_community | 3 |
| `Comments_add → Default` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "comments_list"})` — see callers and callees
2. `gitnexus_query({query: "cluster_64"})` — find related execution flows
3. Read key files listed above for implementation details
