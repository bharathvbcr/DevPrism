---
name: cluster-15
description: "Skill for the Cluster_15 area of DevPrism. 12 symbols across 1 files."
---

# Cluster_15

12 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `apps/`
- Understanding how check_uv_status, setup_project_venv, uv_add_packages work
- Modifying cluster_15-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/uv.rs` | find_uv_binary, venv_bin_dir, venv_python, venv_pip, venv_pip_shim (+7) |

## Entry Points

Start here when exploring this area:

- **`check_uv_status`** (Function) — `apps/desktop/src-tauri/src/uv.rs:217`
- **`setup_project_venv`** (Function) — `apps/desktop/src-tauri/src/uv.rs:373`
- **`uv_add_packages`** (Function) — `apps/desktop/src-tauri/src/uv.rs:420`
- **`uv_run_command`** (Function) — `apps/desktop/src-tauri/src/uv.rs:460`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `check_uv_status` | Function | `apps/desktop/src-tauri/src/uv.rs` | 217 |
| `setup_project_venv` | Function | `apps/desktop/src-tauri/src/uv.rs` | 373 |
| `uv_add_packages` | Function | `apps/desktop/src-tauri/src/uv.rs` | 420 |
| `uv_run_command` | Function | `apps/desktop/src-tauri/src/uv.rs` | 460 |
| `find_uv_binary` | Function | `apps/desktop/src-tauri/src/uv.rs` | 16 |
| `venv_bin_dir` | Function | `apps/desktop/src-tauri/src/uv.rs` | 93 |
| `venv_python` | Function | `apps/desktop/src-tauri/src/uv.rs` | 104 |
| `venv_pip` | Function | `apps/desktop/src-tauri/src/uv.rs` | 115 |
| `venv_pip_shim` | Function | `apps/desktop/src-tauri/src/uv.rs` | 126 |
| `path_with_venv` | Function | `apps/desktop/src-tauri/src/uv.rs` | 137 |
| `write_pip_shim` | Function | `apps/desktop/src-tauri/src/uv.rs` | 147 |
| `ensure_venv_pip` | Function | `apps/desktop/src-tauri/src/uv.rs` | 185 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Setup_project_venv → Venv_bin_dir` | intra_community | 4 |

## How to Explore

1. `gitnexus_context({name: "check_uv_status"})` — see callers and callees
2. `gitnexus_query({query: "cluster_15"})` — find related execution flows
3. Read key files listed above for implementation details
