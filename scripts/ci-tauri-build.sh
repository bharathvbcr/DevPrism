#!/usr/bin/env bash
# CI/local helper: build the desktop Tauri app with signing disabled when secrets
# are missing (matches scripts/build-desktop.mjs behavior).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?usage: ci-tauri-build.sh <rust-target>}"

BUILD_ARGS=(tauri build --target "$TARGET")

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  BUILD_ARGS+=(--config src-tauri/tauri.local-build.conf.json)
fi

if [[ "$TARGET" == *-apple-* ]] && [ -z "${APPLE_CERTIFICATE:-}" ]; then
  BUILD_ARGS+=(--no-sign)
fi

cd "$ROOT/apps/desktop"
pnpm --filter @devprism/desktop "${BUILD_ARGS[@]}"
