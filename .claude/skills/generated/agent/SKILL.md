---
name: agent
description: "Skill for the Agent area of devprism-main. 24 symbols across 5 files."
---

# Agent

24 symbols | 5 files | Cohesion: 78%

## When to Use

- Working with code in `apps/`
- Understanding how new, new, run_repl work
- Modifying agent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/desktop/src-tauri/src/agent/mod.rs` | default, new, default, new, orchestrator_new_keeps_project_state_tools (+12) |
| `apps/desktop/src-tauri/src/agent/cli.rs` | run_repl, run_chat, init_provider |
| `apps/desktop/src-tauri/src/agent/redactor.rs` | redact, test_redaction |
| `apps/desktop/src-tauri/src/lib.rs` | create_new_window |
| `apps/desktop/src-tauri/src/agent/tools/mod.rs` | add_tool |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `apps/desktop/src-tauri/src/agent/mod.rs:180`
- **`new`** (Function) — `apps/desktop/src-tauri/src/agent/mod.rs:330`
- **`run_repl`** (Function) — `apps/desktop/src-tauri/src/agent/cli.rs:9`
- **`run_chat`** (Function) — `apps/desktop/src-tauri/src/agent/cli.rs:56`
- **`add_tool`** (Function) — `apps/desktop/src-tauri/src/agent/tools/mod.rs:734`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `new` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 180 |
| `new` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 330 |
| `run_repl` | Function | `apps/desktop/src-tauri/src/agent/cli.rs` | 9 |
| `run_chat` | Function | `apps/desktop/src-tauri/src/agent/cli.rs` | 56 |
| `add_tool` | Function | `apps/desktop/src-tauri/src/agent/tools/mod.rs` | 734 |
| `redact` | Function | `apps/desktop/src-tauri/src/agent/redactor.rs` | 32 |
| `run_task` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 367 |
| `continue_task` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 377 |
| `run_task_with_reporter` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 387 |
| `continue_task_with_reporter` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 405 |
| `create_new_window` | Function | `apps/desktop/src-tauri/src/lib.rs` | 285 |
| `default` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 24 |
| `default` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 322 |
| `orchestrator_new_keeps_project_state_tools` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 596 |
| `init_provider` | Function | `apps/desktop/src-tauri/src/agent/cli.rs` | 64 |
| `test_redaction` | Function | `apps/desktop/src-tauri/src/agent/redactor.rs` | 50 |
| `run_loop` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 421 |
| `chat_stream` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 582 |
| `ensure_spinner` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 186 |
| `clear_spinner` | Function | `apps/desktop/src-tauri/src/agent/mod.rs` | 204 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Run_repl → Cmp` | cross_community | 5 |
| `Run_chat → Cmp` | cross_community | 5 |
| `Run_task → Cmp` | cross_community | 5 |
| `Continue_task → Cmp` | cross_community | 5 |
| `Run_repl → Redact` | cross_community | 4 |
| `Run_repl → Chat_stream` | cross_community | 4 |
| `Run_repl → New` | cross_community | 4 |
| `Run_chat → Redact` | cross_community | 4 |
| `Run_chat → Chat_stream` | cross_community | 4 |
| `Run_chat → New` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Tools | 2 calls |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "agent"})` — find related execution flows
3. Read key files listed above for implementation details
