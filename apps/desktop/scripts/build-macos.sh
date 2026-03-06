#!/bin/bash
set -euo pipefail

# Build, sign, notarize, and staple ClaudePrism for macOS.
#
# Usage:
#   ./scripts/build-macos.sh              # full build + notarize DMG
#   ./scripts/build-macos.sh --skip-notarize   # build + sign only (for testing)
#
# Prerequisites:
#   - Developer ID certificate in Keychain Access
#   - src-tauri/.env with APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/src-tauri/.env"
TARGET="aarch64-apple-darwin"
BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle"
SKIP_NOTARIZE=false

for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=true ;;
  esac
done

# ── Load .env ──
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found"
  exit 1
fi
set -a
source "$ENV_FILE"
set +a

# ── Validate ──
for var in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set in .env"
    exit 1
  fi
done

if ! security find-identity -v -p codesigning | grep -q "$APPLE_SIGNING_IDENTITY"; then
  echo "Error: Signing identity '$APPLE_SIGNING_IDENTITY' not found in keychain."
  exit 1
fi

echo "==> Signing identity: $APPLE_SIGNING_IDENTITY"

# ── Build ──
# Use --skip-stapling because Tauri only notarizes .app (not .dmg).
# We notarize the DMG ourselves below, which is the correct approach.
echo "==> Building..."
cd "$PROJECT_DIR"
pnpm tauri build --target "$TARGET" --skip-stapling

APP_PATH="$BUNDLE_DIR/macos/ClaudePrism.app"
DMG_PATH="$(find "$BUNDLE_DIR/dmg" -name '*.dmg' | head -1)"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: App bundle not found at $APP_PATH"
  exit 1
fi
if [ -z "$DMG_PATH" ] || [ ! -f "$DMG_PATH" ]; then
  echo "Error: DMG not found in $BUNDLE_DIR/dmg/"
  exit 1
fi

echo "==> App: $APP_PATH"
echo "==> DMG: $DMG_PATH"

if [ "$SKIP_NOTARIZE" = true ]; then
  echo "==> Skipping notarization (--skip-notarize)"
  echo "==> Done!"
  exit 0
fi

# ── Notarize DMG ──
# The correct flow: sign .app → build .dmg (Tauri does this) → notarize .dmg → staple both.
# Notarizing the DMG automatically covers the .app inside it.
echo "==> Notarizing DMG..."
SUBMIT_OUTPUT=$(xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD" \
  --wait \
  --timeout 30m \
  2>&1) || true

echo "$SUBMIT_OUTPUT"

if echo "$SUBMIT_OUTPUT" | grep -q "status: Accepted"; then
  echo "==> Notarization accepted!"
else
  echo "==> Notarization failed or timed out."
  # Extract submission ID for log retrieval
  SUB_ID=$(echo "$SUBMIT_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -n "$SUB_ID" ]; then
    echo "==> Fetching notarization log..."
    xcrun notarytool log "$SUB_ID" \
      --apple-id "$APPLE_ID" \
      --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_PASSWORD" 2>&1 || true
  fi
  exit 1
fi

# ── Staple ──
echo "==> Stapling DMG..."
xcrun stapler staple "$DMG_PATH"

echo "==> Stapling app..."
xcrun stapler staple "$APP_PATH"

echo ""
echo "==> Build complete!"
echo "    DMG: $DMG_PATH"
echo "    App: $APP_PATH"
