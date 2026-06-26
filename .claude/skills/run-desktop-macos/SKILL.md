---
name: run-desktop-macos
description: Launch and drive the DevPrism desktop app (Tauri dev) on macOS. Use when asked to run, start, preview, or screenshot the Mac app, or to confirm a change works in the real desktop window. Covers the one-time native-dependency setup that plain `pnpm dev:desktop` does not handle on macOS.
---

# Run the DevPrism desktop app on macOS

The Tauri shell embeds **Tectonic** (a LaTeX engine) which compiles C/C++ that
links against `icu4c`, `harfbuzz`, `freetype`, `graphite2`, `fontconfig`, and
`openssl`. The repo's `pnpm dev:desktop` script only sets the Tectonic build
env vars on **Windows**, so on macOS you must supply them yourself. The wrapper
script `scripts/dev-desktop-macos.sh` does this.

## One-time prerequisites

Run these once per machine (skip any already present):

```bash
# Native libs Tectonic links against, plus pkg-config
brew install icu4c harfbuzz freetype graphite2 fontconfig openssl@3 pkgconf

# pnpm (matches packageManager in package.json); install globally if not on PATH
npm install -g pnpm@10.28.2   # only if `which pnpm` is empty

# Dependencies — MUST be installed on macOS. A node_modules copied from
# Windows/Linux is missing the darwin @tauri-apps/cli binary and the build
# dies with "Cannot find module './cli.darwin-arm64.node'". If that happens:
CI=true pnpm install          # CI=true lets pnpm recreate node_modules without a TTY prompt
```

Sanity check the keg-only libs resolve before building:

```bash
PKG_CONFIG_PATH="$(brew --prefix icu4c@78)/lib/pkgconfig:$(brew --prefix openssl@3)/lib/pkgconfig" \
  pkg-config --modversion icu-uc harfbuzz openssl
```

## Launch

```bash
scripts/dev-desktop-macos.sh
```

This exports the required flags and runs `pnpm dev:desktop`:

- `PKG_CONFIG_PATH` → keg-only `icu4c@78` and `openssl@3` pkgconfig dirs.
- `CXXFLAGS=-std=c++17` → ICU 78 headers require C++17 (the default `-std=c++14`
  fails with `'auto' not allowed in template parameter until C++17`).
- `CXXFLAGS/CFLAGS -I$(brew --prefix harfbuzz)/include` → Homebrew harfbuzz 14
  puts headers under `include/harfbuzz/`, so `<harfbuzz/hb.h>` needs the parent
  include dir (pkg-config only offers `.../include/harfbuzz`).

**First run compiles the full Rust + Tectonic tree (~several minutes).** Run it
in the background and watch the log for:

- `Finished \`dev\` profile` followed by `Running \`target/debug/claude-prism-desktop\`` — the binary launched.
- `VITE … ready` / `Local: http://localhost:1420/` — the frontend dev server is up.

## Drive it / verify

The window is a native Tauri webview; the running `tauri dev` binary is **not a
bundled `.app`**, so macOS screen-capture permission tools can't grant it and you
can't screenshot it directly. Verify via the dev-server log instead:

- Confirm the process is alive: `pgrep -fl claude-prism-desktop`.
- Watch for runtime JS errors in the launch log, e.g.
  `[js] [ERROR][app] Unhandled promise rejection`. A `SyntaxError: Importing
  binding name 'X' is not found` means a source module is empty/truncated or
  missing an export — check `git status` for a 0-byte tracked file.
- Vite HMR applies edits live; the log prints `[vite] (client) hmr update …`.

## Gotchas seen in practice

- **`command not found: pnpm`** in a non-login shell → `npm install -g pnpm@10.28.2`.
- **`Cannot find native binding … cli.darwin-arm64.node`** → node_modules is from
  another OS; `CI=true pnpm install` to rebuild for macOS.
- **`pkg-config command could not be found`** → `brew install pkgconf`.
- **`'harfbuzz/hb.h' file not found`** → harfbuzz include dir not on the path; the
  wrapper's `-I$(brew --prefix harfbuzz)/include` fixes it.
- **ICU `'auto' not allowed in template parameter`** → missing `-std=c++17`.
