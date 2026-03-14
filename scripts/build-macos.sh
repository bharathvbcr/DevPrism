#!/usr/bin/env bash
set -euo pipefail

# Load signing & notarization env vars
ENV_FILE="apps/desktop/src-tauri/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "Error: $ENV_FILE not found"
  exit 1
fi

TARGET="aarch64-apple-darwin"
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "==> Building ClaudePrism $TAG for macOS ($TARGET)"

# Build
export TECTONIC_DEP_BACKEND=vcpkg
export VCPKG_ROOT="$HOME/vcpkg"
export CXXFLAGS="-std=c++17"
export CFLAGS=""

pnpm --filter @claude-prism/desktop tauri build --target "$TARGET"

# Notarize DMG
DMG_PATH=$(find "apps/desktop/src-tauri/target/$TARGET/release/bundle/dmg" -name '*.dmg' | head -1)
APP_PATH="apps/desktop/src-tauri/target/$TARGET/release/bundle/macos/ClaudePrism.app"

if [ -z "$DMG_PATH" ]; then
  echo "Error: DMG not found"
  exit 1
fi

echo "==> Notarizing $DMG_PATH ..."
xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD" \
  --wait --timeout 30m

echo "==> Stapling..."
xcrun stapler staple "$DMG_PATH"
xcrun stapler staple "$APP_PATH"

# Upload to GitHub Release
echo "==> Uploading to GitHub Release $TAG"
gh release view "$TAG" --repo delibae/claude-prism >/dev/null 2>&1 || \
  gh release create "$TAG" --repo delibae/claude-prism --title "ClaudePrism $TAG" --generate-notes

gh release upload "$TAG" \
  --repo delibae/claude-prism \
  --clobber \
  "$DMG_PATH"

echo "==> Done! macOS build uploaded to $TAG"
