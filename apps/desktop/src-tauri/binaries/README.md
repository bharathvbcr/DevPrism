# manvi sidecar binaries

This directory holds the `manvi` sidecar that Tauri bundles into the app. It is
**generated, not committed** — `.gitignore` excludes everything here except this
file — because each binary is ~8 MB and there is one per release target.

## What the sidecar does

`manvi serve` gives DevPrism two things the Rust side would otherwise have to
reimplement:

- **A policy gate.** Write and command rules pinned against DevCouncil's own
  engine by a parity fixture. Without it, tool calls run past nothing but
  `is_catastrophic()`.
- **A context planner.** Reads a model's real context window off Ollama, vLLM
  or llama.cpp instead of defaulting to 8192, plans prefix-stable compaction,
  and recovers tool calls a local server failed to parse.

The app degrades gracefully without it — see `native_agent/manvi_sidecar.rs`,
where every call returns `Verdict::Unavailable` rather than a verdict — but a
bundle without it is meaningfully less safe and slower on local models.

## Building

```bash
node scripts/build-manvi.mjs                       # host target
node scripts/build-manvi.mjs --target x86_64-apple-darwin
```

`scripts/build-desktop.mjs` runs this automatically before `tauri build`, for
whichever target is being built.

The source is **not vendored here**. The script finds it by, in order:

1. `MANVI_SRC` — an explicit path. If set and wrong, the build fails rather
   than falling through, because someone set it on purpose.
2. `../Dev_Harness/manvi` or `../manvi` beside this repository.

manvi is pure Go with `CGO_ENABLED=0`, so every release target cross-compiles
from any machine with a Go toolchain.

## When it cannot be built

The build **warns and continues**, producing an app without the sidecar. That
is the default because DevPrism's CI has no manvi checkout, and breaking every
release over an optional component would be the wrong trade.

For a release build you almost certainly want the opposite:

```bash
DEVPRISM_MANVI_REQUIRED=1 node scripts/build-desktop.mjs
```

which turns "could not build the sidecar" into a hard failure.

**CI does not currently build the sidecar.** `.github/workflows/build-desktop.yml`
checks out only this repository, so released artifacts ship without it until a
manvi checkout (or a vendored binary) is added to those jobs.

## How it is found at runtime

Tauri looks for `manvi-<target-triple>{.exe}` here at bundle time and installs
it beside the app executable under the plain name `manvi` — the same location
its own `relative_command_path` resolves against. `resolve_binary()` in
`native_agent/manvi_sidecar.rs` searches, in order:

1. `DEVPRISM_MANVI_BIN` — an explicit override, for running against a local
   build. Set and wrong is an error, not a fallthrough.
2. Beside the current executable (where the bundle puts it).
3. `manvi` on `PATH`.

## macOS signing

`tauri build` signs bundled external binaries as part of the `.app`. Builds
passing `--no-sign` (including `pnpm build:macos`) do not, so a sidecar in such
a bundle may need re-signing before it will launch on another machine.
