# manvi sidecar binaries

This directory holds the `manvi` sidecar that Tauri bundles into the app. It is
**generated, not committed** — `.gitignore` excludes everything here except this
file — because each binary is ~8 MB and there is one per release target.

## What the binary does

Chat turns spawn this binary as `manvi run --json`. DevPrism translates its
event stream into the chat UI. A missing binary fails the turn. It is not
optional for Ollama, OpenAI-compatible, or Claude chat.

`native_agent/manvi_sidecar.rs` can still talk to `manvi serve` for the older
policy and context-planner calls. Those calls are not the chat turn. The
resolver is the same: `DEVPRISM_MANVI_BIN`, then beside the executable, then
the newer of this directory's `manvi-<triple>` and `manvi` on `PATH`. An
override that is set and missing is an error. `bun run dev:desktop` rebuilds
the sidecar when the Manvi checkout's Go sources are newer than that file.

## Building

```bash
node scripts/build-manvi.mjs                       # host target
node scripts/build-manvi.mjs --target x86_64-apple-darwin
```

`scripts/build-desktop.mjs` runs this automatically before `tauri build`, for
whichever target is being built.

The source is **not vendored here**. The script finds it by, in order:

1. `MANVI_SRC` — an explicit path. If set and wrong, the build fails rather
   than falling through, because someone set it on purpose. A path to the
   Manvi repository (module in `manvi/`) is accepted, as is a path to the
   module itself.
2. `../Dev_Harness/manvi`, `../manvi`, or `../Manvi` beside this repository,
   including the nested `manvi/` module inside that checkout.

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
manvi checkout (or a vendored binary) is added to those jobs. The app still
launches. A chat turn then fails until `manvi` is on `PATH` or
`DEVPRISM_MANVI_BIN` names a binary.

## How it is found at runtime

Tauri looks for `manvi-<target-triple>{.exe}` here at bundle time and installs
it beside the app executable under the plain name `manvi` — the same location
its own `relative_command_path` resolves against. `resolve_binary()` in
`native_agent/manvi_sidecar.rs` searches, in order:

1. `DEVPRISM_MANVI_BIN` — an explicit override, for running against a local
   build. Set and wrong is an error, not a fallthrough.
2. Beside the current executable (where the bundle puts it), and the parent of
   that directory when the executable is under `deps`. A packaged app stops
   here, so a leftover checkout binary cannot replace the one that shipped.
3. The newer of `binaries/manvi-<target-triple>` (this directory, found from
   the crate path baked in at compile time) and `manvi` on `PATH`. Equal
   mtimes keep the checkout copy.

## macOS signing

`tauri build` signs bundled external binaries as part of the `.app`. Builds
passing `--no-sign` (including `bun run build:macos`) do not, so a sidecar in such
a bundle may need re-signing before it will launch on another machine.
