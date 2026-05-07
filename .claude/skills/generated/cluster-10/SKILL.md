---
name: cluster-10
description: "Skill for the Cluster_10 area of devprism-main. 11 symbols across 1 files."
---

# Cluster_10

11 symbols | 1 files | Cohesion: 91%

## When to Use

- Working with code in `apps/`
- Understanding how into_parsed, parse_markdown_with_frontmatter, test_parse_markdown_no_frontmatter work
- Modifying cluster_10-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/slash_commands.rs` | into_parsed, parse_markdown_with_frontmatter, test_parse_markdown_no_frontmatter, test_parse_markdown_empty, test_parse_markdown_with_valid_frontmatter (+6) |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `into_parsed` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 36 |
| `parse_markdown_with_frontmatter` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 67 |
| `test_parse_markdown_no_frontmatter` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 760 |
| `test_parse_markdown_empty` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 767 |
| `test_parse_markdown_with_valid_frontmatter` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 774 |
| `test_parse_markdown_with_allowed_tools` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 784 |
| `test_parse_markdown_unclosed_frontmatter` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 793 |
| `test_parse_skill_frontmatter_with_extra_fields` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 838 |
| `test_parse_skill_frontmatter_minimal` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 856 |
| `test_parse_skill_frontmatter_with_string_allowed_tools` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 866 |
| `test_parse_skill_frontmatter_with_space_separated_allowed_tools` | Function | `apps/desktop/src-tauri/src/slash_commands.rs` | 879 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Slash_command_delete → CommandFrontmatter` | cross_community | 6 |
| `Manual_skill_delete → CommandFrontmatter` | cross_community | 6 |
| `Slash_command_get → CommandFrontmatter` | cross_community | 6 |
| `Manual_skill_save → CommandFrontmatter` | cross_community | 5 |
| `Test_parse_markdown_no_frontmatter → CommandFrontmatter` | intra_community | 4 |
| `Test_parse_markdown_empty → CommandFrontmatter` | intra_community | 4 |
| `Test_parse_markdown_with_valid_frontmatter → CommandFrontmatter` | intra_community | 4 |
| `Test_parse_markdown_with_allowed_tools → CommandFrontmatter` | intra_community | 4 |
| `Test_parse_markdown_unclosed_frontmatter → CommandFrontmatter` | intra_community | 4 |

## How to Explore

1. `gitnexus_context({name: "into_parsed"})` — see callers and callees
2. `gitnexus_query({query: "cluster_10"})` — find related execution flows
3. Read key files listed above for implementation details
