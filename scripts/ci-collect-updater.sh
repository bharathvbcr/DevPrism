#!/usr/bin/env bash
# Collect signed updater artifacts for the publish job. Never fails when unsigned
# builds omit .sig files or bundle directories.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="${1:?usage: ci-collect-updater.sh <windows|macos|macos-intel|linux>}"
TARGET="${2:?usage: ci-collect-updater.sh <platform> <rust-target>}"

BUNDLE="$ROOT/apps/desktop/src-tauri/target/$TARGET/release/bundle"
SIG=""
ARTIFACT=""

case "$PLATFORM" in
  windows)
    if [ -d "$BUNDLE/nsis" ]; then
      SIG=$(find "$BUNDLE/nsis" -name '*-setup.exe.sig' 2>/dev/null | head -1 || true)
      ARTIFACT=$(find "$BUNDLE/nsis" -name '*-setup.exe' ! -name '*.sig' 2>/dev/null | head -1 || true)
    fi
    ;;
  macos|macos-intel)
    if [ -d "$BUNDLE/macos" ]; then
      SIG=$(find "$BUNDLE/macos" -name '*.app.tar.gz.sig' 2>/dev/null | head -1 || true)
      ARTIFACT=$(find "$BUNDLE/macos" -name '*.app.tar.gz' ! -name '*.sig' 2>/dev/null | head -1 || true)
    fi
    ;;
  linux)
    if [ -d "$BUNDLE/appimage" ]; then
      SIG=$(find "$BUNDLE/appimage" -name '*.AppImage.sig' 2>/dev/null | head -1 || true)
      ARTIFACT=$(find "$BUNDLE/appimage" -name '*.AppImage' ! -name '*.sig' 2>/dev/null | head -1 || true)
    fi
    ;;
  *)
    echo "Unknown platform: $PLATFORM" >&2
    exit 1
    ;;
esac

if [ -n "$SIG" ] && [ -n "$ARTIFACT" ]; then
  {
    echo "sig<<EOF"
    cat "$SIG"
    echo "EOF"
    echo "url=$(basename "$ARTIFACT")"
  } >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"
  echo "Collected updater artifact: $(basename "$ARTIFACT")"
else
  echo "No signed updater artifacts (unsigned build or signing key not configured)."
fi
