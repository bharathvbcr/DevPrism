#!/usr/bin/env bash
set -euo pipefail

REPO="bharathvbcr/DevPrism"

# Load env vars (for TAURI_SIGNING_PRIVATE_KEY_PATH)
ENV_FILE="apps/desktop/src-tauri/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

TARGET="x86_64-unknown-linux-gnu"
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "==> Building DevPrism $TAG for Linux ($TARGET)"

# Build
export TECTONIC_DEP_BACKEND=pkg-config
export TECTONIC_PKGCONFIG_FORCE_SEMI_STATIC=true
export CXXFLAGS="-std=c++17"
export CFLAGS=""

bash scripts/ci-tauri-build.sh "$TARGET"

BUNDLE_DIR="apps/desktop/src-tauri/target/$TARGET/release/bundle"

# Find outputs
DEB_PATH=$(find "$BUNDLE_DIR/deb" -name '*.deb' 2>/dev/null | head -1 || true)
RPM_PATH=$(find "$BUNDLE_DIR/rpm" -name '*.rpm' 2>/dev/null | head -1 || true)
APPIMAGE_PATH=$(find "$BUNDLE_DIR/appimage" -name '*.AppImage' ! -name '*.sig' 2>/dev/null | head -1 || true)
APPIMAGE_SIG=$(find "$BUNDLE_DIR/appimage" -name '*.AppImage.sig' 2>/dev/null | head -1 || true)

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

# --- Auto-updater artifacts (only when signing key is configured) ---
if [ -n "$APPIMAGE_PATH" ] && [ -n "$APPIMAGE_SIG" ]; then
  SIGNATURE=$(cat "$APPIMAGE_SIG")
  PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  LATEST_JSON="apps/desktop/src-tauri/target/latest.json"
  RELEASE_URL="https://github.com/$REPO/releases/download/$TAG/DevPrism-Linux.AppImage"

  if [ -f "$LATEST_JSON" ]; then
    node -e "
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync('$LATEST_JSON', 'utf8'));
      data.platforms['linux-x86_64'] = {
        signature: \`$SIGNATURE\`,
        url: '$RELEASE_URL'
      };
      fs.writeFileSync('$LATEST_JSON', JSON.stringify(data, null, 2));
    "
  else
    cat > "$LATEST_JSON" <<EOF
{
  "version": "$VERSION",
  "notes": "DevPrism $TAG",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "linux-x86_64": {
      "signature": "$SIGNATURE",
      "url": "$RELEASE_URL"
    }
  }
}
EOF
  fi
  echo "==> Generated latest.json with linux-x86_64"
  ASSETS+=("$LATEST_JSON")
elif [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "Warning: AppImage updater artifacts not found, skipping latest.json"
else
  echo "==> Unsigned build (no TAURI_SIGNING_PRIVATE_KEY); skipping latest.json"
fi

# Upload to GitHub Release
echo "==> Uploading to GitHub Release $TAG"
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || \
  gh release create "$TAG" --repo "$REPO" --title "DevPrism $TAG" --generate-notes

gh release upload "$TAG" \
  --repo "$REPO" \
  --clobber \
  "${ASSETS[@]}"

echo "==> Done! Linux build uploaded to $TAG"
