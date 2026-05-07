---
name: cluster-14
description: "Skill for the Cluster_14 area of devprism-main. 10 symbols across 1 files."
---

# Cluster_14

10 symbols | 1 files | Cohesion: 71%

## When to Use

- Working with code in `apps/`
- Understanding how slash_commands_list, slash_command_get, manual_skill_save work
- Modifying cluster_14-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/slash_commands.rs` | load_skills_from_dir, create_default_commands, slash_commands_list, slash_command_get, manual_skill_save (+5) |

## Entry Points

Start here when exploring this area:

- **`slash_commands_list`** (Function) — `apps/desktop/src-tauri/src/slash_commands.rs:391`
- **`slash_command_get`** (Function) — `apps/desktop/src-tauri/src/slash_commands.rs:498`
- **`manual_skill_save`** (Function) — `apps/desktop/src-tauri/src/slash_commands.rs:597`
- **`manual_skill_delete`** (Function) — `apps/desktop/src-tauri/src/slash_commands.rs:664`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `slash_commands_list` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 391 |
| `slash_command_get` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 498 |
| `manual_skill_save` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 597 |
| `manual_skill_delete` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 664 |
| `load_skills_from_dir` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 199 |
| `create_default_commands` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 274 |
| `sanitize_name` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 729 |
| `test_load_skills_from_dir` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 892 |
| `test_real_skills_dir` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 950 |
| `test_create_default_commands_structure` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 1158 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Slash_command_delete → CommandFrontmatter` | cross_community | 6 |
| `Manual_skill_delete → CommandFrontmatter` | cross_community | 6 |
| `Slash_command_get → CommandFrontmatter` | cross_community | 6 |
| `Manual_skill_save → CommandFrontmatter` | cross_community | 5 |
| `Manual_skill_save → Get_knowledge_dir` | cross_community | 4 |
| `Slash_command_delete → Extract_command_info` | cross_community | 4 |
| `Slash_command_delete → SlashCommand` | cross_community | 4 |
| `Slash_command_delete → Cmp` | cross_community | 4 |
| `Manual_skill_delete → Extract_command_info` | cross_community | 4 |
| `Manual_skill_delete → SlashCommand` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Knowledge | 3 calls |
| Cluster_10 | 1 calls |
| Tools | 1 calls |
| Cluster_13 | 1 calls |
| Cluster_12 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "slash_commands_list"})` — see callers and callees
2. `gitnexus_query({query: "cluster_14"})` — find related execution flows
3. Read key files listed above for implementation details
