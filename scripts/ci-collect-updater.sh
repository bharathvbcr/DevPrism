#!/usr/bin/env bash
# Collect signed updater artifacts for the publish job. Unsigned local builds may
# omit .sig files or bundle directories; pass --expect-signed to fail instead of
# silently succeeding without updater artifacts (used in CI when the signing key
# secret is configured).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXPECT_SIGNED=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --expect-signed) EXPECT_SIGNED=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
PLATFORM="${ARGS[0]:?usage: ci-collect-updater.sh <windows|macos|macos-intel|linux> <rust-target> [--expect-signed]}"
TARGET="${ARGS[1]:?usage: ci-collect-updater.sh <platform> <rust-target> [--expect-signed]}"

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
elif [ "$EXPECT_SIGNED" = "1" ]; then
  echo "ERROR: signing key is configured but no signed updater artifacts were found for $PLATFORM." >&2
  echo "Refusing to publish a release with a silently missing updater platform. Checked: $BUNDLE" >&2
  exit 1
else
  echo "No signed updater artifacts (unsigned build or signing key not configured)."
fi
