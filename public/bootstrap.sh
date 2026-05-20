#!/bin/bash
set -euo pipefail

BASE_URL="${BRIDGE_URL:-https://cya.wastu.net}"

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Normalize architecture naming
if [ "$ARCH" = "x86_64" ]; then ARCH="x64"; fi
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then ARCH="arm64"; fi

# Map OS names
if [ "$OS" = "darwin" ]; then OS="darwin"; fi
if [ "$OS" = "linux" ]; then OS="linux"; fi

BIN_NAME="bridge-agent-${OS}-${ARCH}"
if [ "$OS" = "windows" ] || [ "${OS:-}" = "msys" ] || [ "${OS:-}" = "cygwin" ]; then
  BIN_NAME="bridge-agent-windows-x64.exe"
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading agent for ${OS}-${ARCH}..."
curl -fsSL "${BASE_URL}/bin/${BIN_NAME}" -o "${TMPDIR}/${BIN_NAME}"
chmod +x "${TMPDIR}/${BIN_NAME}"

echo "Starting agent..."
"${TMPDIR}/${BIN_NAME}"
