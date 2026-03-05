#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/src-tauri/.env"

# Load .env
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found"
  exit 1
fi
set -a
source "$ENV_FILE"
set +a

# Validate required vars
for var in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set in .env"
    exit 1
  fi
done

# Import certificate into temporary keychain
RUNNER_TEMP_DIR="${TMPDIR:-/tmp}"
KEYCHAIN_PATH="$RUNNER_TEMP_DIR/build-signing.keychain-db"
CERT_PATH="$RUNNER_TEMP_DIR/certificate.p12"
KEYCHAIN_PASSWORD="build-local-$$"

cleanup() {
  echo "Cleaning up keychain..."
  security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || true
  rm -f "$CERT_PATH"
}
trap cleanup EXIT

echo "==> Importing certificate into temporary keychain..."
echo -n "$APPLE_CERTIFICATE" | base64 --decode -o "$CERT_PATH"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$CERT_PATH" \
  -P "$APPLE_CERTIFICATE_PASSWORD" \
  -A -t cert -f pkcs12 \
  -k "$KEYCHAIN_PATH"
security set-key-partition-list -S apple-tool:,apple: \
  -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
# Prepend our keychain so codesign finds the cert
security list-keychain -d user -s "$KEYCHAIN_PATH" $(security list-keychain -d user | tr -d '"')

echo "==> Certificate imported. Building..."
cd "$PROJECT_DIR"
pnpm tauri build --target aarch64-apple-darwin --skip-stapling

echo "==> Build complete!"
