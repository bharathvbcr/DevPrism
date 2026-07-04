#!/usr/bin/env bash
set -euo pipefail

REPO="bharathvbcr/DevPrism"

# Load signing & notarization env vars when present
ENV_FILE="apps/desktop/src-tauri/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

TARGET="aarch64-apple-darwin"
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "==> Building DevPrism $TAG for macOS ($TARGET)"

export TECTONIC_DEP_BACKEND=vcpkg
export VCPKG_ROOT="${VCPKG_ROOT:-$HOME/vcpkg}"
export CXXFLAGS="-std=c++17"
export CFLAGS=""

bash scripts/ci-tauri-build.sh "$TARGET"

BUNDLE_DIR="apps/desktop/src-tauri/target/$TARGET/release/bundle"
DMG_PATH=$(find "$BUNDLE_DIR/dmg" -name '*.dmg' 2>/dev/null | head -1 || true)
APP_PATH="$BUNDLE_DIR/macos/DevPrism.app"

if [ -z "$DMG_PATH" ]; then
  echo "Error: DMG not found"
  exit 1
fi

if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_CERTIFICATE:-}" ]; then
  echo "==> Notarizing $DMG_PATH ..."
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_PASSWORD" \
    --wait --timeout 30m

  echo "==> Stapling..."
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler staple "$APP_PATH"
else
  echo "==> Skipping notarization (Apple credentials not configured)"
fi

UPDATE_TAR=$(find "$BUNDLE_DIR/macos" -name '*.app.tar.gz' ! -name '*.sig' 2>/dev/null | head -1 || true)
UPDATE_SIG=$(find "$BUNDLE_DIR/macos" -name '*.app.tar.gz.sig' 2>/dev/null | head -1 || true)
LATEST_JSON="apps/desktop/src-tauri/target/latest.json"

if [ -n "$UPDATE_TAR" ] && [ -n "$UPDATE_SIG" ]; then
  SIGNATURE=$(cat "$UPDATE_SIG")
  PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  RELEASE_URL="https://github.com/$REPO/releases/download/$TAG/DevPrism-macOS.app.tar.gz"

  if [ -f "$LATEST_JSON" ]; then
    node -e "
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync('$LATEST_JSON', 'utf8'));
      data.platforms['darwin-aarch64'] = {
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
    "darwin-aarch64": {
      "signature": "$SIGNATURE",
      "url": "$RELEASE_URL"
    }
  }
}
EOF
  fi
  echo "==> Generated latest.json with darwin-aarch64"
else
  echo "==> No signed updater artifacts; skipping latest.json"
fi

echo "==> Uploading to GitHub Release $TAG"
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || \
  gh release create "$TAG" --repo "$REPO" --title "DevPrism $TAG" --generate-notes

RENAMED_DMG="apps/desktop/src-tauri/target/DevPrism-macOS.dmg"
cp "$DMG_PATH" "$RENAMED_DMG"
UPLOAD_ASSETS=("$RENAMED_DMG")

if [ -n "${UPDATE_TAR:-}" ]; then
  RENAMED_TAR="apps/desktop/src-tauri/target/DevPrism-macOS.app.tar.gz"
  cp "$UPDATE_TAR" "$RENAMED_TAR"
  UPLOAD_ASSETS+=("$RENAMED_TAR")
fi
[ -f "${LATEST_JSON:-}" ] && UPLOAD_ASSETS+=("$LATEST_JSON")

gh release upload "$TAG" \
  --repo "$REPO" \
  --clobber \
  "${UPLOAD_ASSETS[@]}"

echo "==> Done! macOS build uploaded to $TAG"
