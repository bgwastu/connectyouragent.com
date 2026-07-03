#!/bin/sh
set -eu
BASE_URL="{{origin}}"
CODE="{{code}}"
# BusyBox/OpenWrt: tr '[[:upper:]]' corrupts kernel names — use ASCII y/.
KERNEL=$(uname -s)
OS=$(printf '%s' "$KERNEL" | sed 'y/ABCDEFGHIJKLMNOPQRSTUVWXYZ/abcdefghijklmnopqrstuvwxyz/')
ARCH=$(uname -m)
ARCH=$(printf '%s' "$ARCH" | sed 'y/ABCDEFGHIJKLMNOPQRSTUVWXYZ/abcdefghijklmnopqrstuvwxyz/')
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  mips) ARCH=mips ;;
  mipsel|mips32el) ARCH=mipsel ;;
  mips64) ARCH=mips64 ;;
  mips64el|mipsel64|mips64el-gnuabi64) ARCH=mips64el ;;
esac
# MIPS: OpenWrt (e.g. MT7621) often reports mipsel hardware as `uname -m` = mips.
# ELF EI_DATA at byte offset 5: 1=LITTLE -> mipsel / mips64el, 2=BIG -> mips / mips64.
elf_ei_data() {
  for p in /proc/self/exe /bin/busybox /bin/sh /sbin/init; do
    [ -r "$p" ] || continue
    ei=$(hexdump -n 1 -s 5 -e '"%u"' "$p" 2>/dev/null) || ei=""
    [ -n "$ei" ] || continue
    printf '%s' "$ei"
    return 0
  done
}
case "$ARCH" in
  mips)
    ei=$(elf_ei_data)
    [ "$ei" = "1" ] && ARCH=mipsel
    ;;
  mips64)
    ei=$(elf_ei_data)
    [ "$ei" = "1" ] && ARCH=mips64el
    ;;
esac
BIN_NAME="cya-bridge-${OS}-${ARCH}"
if [ "$OS" != "linux" ] && [ "$OS" != "darwin" ]; then
  echo "Unsupported OS: ${KERNEL} (normalized: ${OS}). Use Linux or macOS."
  exit 1
fi
case "$ARCH" in
  x64|arm64|mips|mipsel|mips64|mips64el) ;;
  *)
    echo "Unsupported CPU arch for this installer: $(uname -m) (normalized: ${ARCH})."
    echo "Download a matching bridge from ${BASE_URL}/bin if your CPU is listed there."
    exit 1
    ;;
esac
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
echo "Downloading bridge for ${OS}-${ARCH}..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${BASE_URL}/bin/${BIN_NAME}" -o "${TMPDIR}/${BIN_NAME}"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "${TMPDIR}/${BIN_NAME}" "${BASE_URL}/bin/${BIN_NAME}"
else
  echo "Neither curl nor wget found. Install one: opkg install curl wget-ssl"
  exit 1
fi
chmod +x "${TMPDIR}/${BIN_NAME}"
BRIDGE_WS_URL="${BASE_URL/http/ws}/ws" BRIDGE_CODE="${CODE}" "${TMPDIR}/${BIN_NAME}" "${CODE}"
