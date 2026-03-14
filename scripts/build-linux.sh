#!/usr/bin/env bash
set -euo pipefail

TARGET="x86_64-unknown-linux-gnu"
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "==> Building ClaudePrism $TAG for Linux ($TARGET)"

# Build
export TECTONIC_DEP_BACKEND=vcpkg
export VCPKG_ROOT="${VCPKG_ROOT:-$HOME/vcpkg}"
export CXXFLAGS="-std=c++17"
export CFLAGS=""

pnpm --filter @claude-prism/desktop tauri build --target "$TARGET"

BUNDLE_DIR="apps/desktop/src-tauri/target/$TARGET/release/bundle"

# Find outputs
DEB_PATH=$(find "$BUNDLE_DIR/deb" -name '*.deb' 2>/dev/null | head -1)
RPM_PATH=$(find "$BUNDLE_DIR/rpm" -name '*.rpm' 2>/dev/null | head -1)
APPIMAGE_PATH=$(find "$BUNDLE_DIR/appimage" -name '*.AppImage' 2>/dev/null | head -1)

ASSETS=()
[ -n "$DEB_PATH" ] && ASSETS+=("$DEB_PATH")
[ -n "$RPM_PATH" ] && ASSETS+=("$RPM_PATH")
[ -n "$APPIMAGE_PATH" ] && ASSETS+=("$APPIMAGE_PATH")

if [ ${#ASSETS[@]} -eq 0 ]; then
  echo "Error: No build artifacts found in $BUNDLE_DIR"
  exit 1
fi

echo "==> Build artifacts:"
printf "    %s\n" "${ASSETS[@]}"

# Upload to GitHub Release
echo "==> Uploading to GitHub Release $TAG"
gh release view "$TAG" --repo delibae/claude-prism >/dev/null 2>&1 || \
  gh release create "$TAG" --repo delibae/claude-prism --title "ClaudePrism $TAG" --generate-notes

gh release upload "$TAG" \
  --repo delibae/claude-prism \
  --clobber \
  "${ASSETS[@]}"

echo "==> Done! Linux build uploaded to $TAG"
