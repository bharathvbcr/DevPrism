# Tauri / Rust Scope

## Repo Map

- Canonical map: `.devcouncil/repo_map.json`
- Ownership boundaries: `docs/DEV_MAP.md`
- Refresh with `dev map` (or `dev map --if-stale`) before broad edits.
- Use it before edits spanning native commands, agent runtime, and Rust integration modules.

## Must Use Map

- Before broad exploration or edits, open `.devcouncil/repo_map.json` (or MCP `devcouncil_repo_map`).
- Before changing a symbol/file, check callers with `dev graph query` / `devcouncil_graph_query`.
- Before risky edits, check blast radius with `dev graph impact` / `devcouncil_impact`.

## Subprocess safety

Every child process goes through `proc::run_with_timeout` (or
`proc::run_with_timeout_and_cancel` when a newer request supersedes the run) —
never `Command::output()`, which waits forever. Retained stdout/stderr is
capped at 64 MiB per stream (`MAX_CAPTURED_OUTPUT`); the pipe is still drained
past the cap so a flooding child cannot deadlock.

- TeX can loop forever on a recursive macro; `-interaction=nonstopmode` stops
  *interactive* hangs but not expansion hangs. A hung compile held a
  `MAX_CONCURRENT` (3) permit, the per-project lock and a blocking thread, so
  three of them disabled compiling for the whole session.
- The timeout path deliberately does **not** join the stdout/stderr reader
  threads: killing a wrapper (a shell script, `latexmk`) leaves a grandchild
  holding the pipe, and joining would block until *it* exits. Pinned by
  `proc::tests::a_hanging_grandchild_does_not_block_the_timeout`.
- Caller-supplied paths that reach a subprocess are confined to the project
  root and rejected if they begin with `-` (`export::resolve_project_relative`).
