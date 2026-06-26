#!/usr/bin/env bash
# Launch the DevPrism desktop app (Tauri dev) on macOS with the Tectonic
# C/C++ dependency flags that the plain `pnpm dev:desktop` script does not set
# on macOS. Without these, the tectonic_xetex_layout build fails to compile
# against Homebrew's current icu4c/harfbuzz.
#
# Prerequisites (one-time):
#   brew install icu4c harfbuzz freetype graphite2 fontconfig openssl@3 pkgconf
#   pnpm install   # must be run on macOS — a node_modules copied from another
#                  # OS will be missing the darwin Tauri CLI binary
#
# Usage: scripts/dev-desktop-macos.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# pkg-config must find keg-only icu4c and openssl
export PKG_CONFIG_PATH="$(brew --prefix icu4c@78)/lib/pkgconfig:$(brew --prefix openssl@3)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

# ICU 78 headers require C++17; Homebrew harfbuzz 14 installs headers under
# include/harfbuzz/, so <harfbuzz/hb.h> needs the parent include dir on the path.
export CXXFLAGS="-std=c++17 -I$(brew --prefix harfbuzz)/include ${CXXFLAGS:-}"
export CFLAGS="-I$(brew --prefix harfbuzz)/include ${CFLAGS:-}"

exec pnpm dev:desktop
