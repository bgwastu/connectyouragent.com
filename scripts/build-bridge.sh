#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
OUT="${OUT:-$ROOT/public/bin}"
BRIDGE="${BRIDGE:-$ROOT/bridge}"
mkdir -p "$OUT"

tolower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

wanted() {
  [ -z "${BUILD_TARGETS:-}" ] && return 0
  oifs=$IFS
  IFS=,
  for t in $(printf '%s' "$BUILD_TARGETS"); do
    tok=$(tolower "$(printf '%s' "$t" | tr -d '[:space:]')")
    if [ "$tok" = "$1" ]; then
      IFS=$oifs
      return 0
    fi
  done
  IFS=$oifs
  return 1
}

build_one() {
  goos="$1"
  goarch="$2"
  out="$3"
  gomips="${4:-}"
  id="$(tolower "${goos}_${goarch}")"
  wanted "$id" || return 0
  echo "Building ${goos}/${goarch} -> ${out}"
  pie=""
  # Android/Termux:
  # 1. Requires PIE executables (ET_DYN / e_type=3). MIPS does not support PIE.
  # 2. Bionic libc requires PT_TLS alignment >= 64. GOOS=linux produces align=8.
  #    GOOS=android avoids this by omitting the TLS segment entirely.
  # So for arm64 (the common Android architecture), build with GOOS=android.
  if [ "$goarch" = "arm64" ] && [ "$goos" = "linux" ]; then
    goos=android
  fi
  # PIE for all Linux/Android targets except MIPS (MIPS doesn't support it)
  if [ "$goos" = "linux" ] || [ "$goos" = "android" ]; then
    case "$goarch" in mips*|mips64*) ;; *) pie="-buildmode=pie" ;; esac
  fi
  (
    cd "$BRIDGE"
    if [ "$gomips" = "softfloat" ]; then
      CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch GOMIPS=softfloat \
        go build -trimpath $pie '-ldflags=-s -w' -o "$OUT/$out" .
    else
      CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
        go build -trimpath $pie '-ldflags=-s -w' -o "$OUT/$out" .
    fi
  )
}

build_one linux amd64 cya-bridge-linux-x64
build_one linux arm64 cya-bridge-linux-arm64
build_one linux mips cya-bridge-linux-mips softfloat
build_one linux mipsle cya-bridge-linux-mipsel softfloat
build_one linux mips64 cya-bridge-linux-mips64
build_one linux mips64le cya-bridge-linux-mips64el
build_one darwin amd64 cya-bridge-darwin-x64
build_one darwin arm64 cya-bridge-darwin-arm64
build_one windows amd64 cya-bridge-windows-x64.exe

echo "Done → ${OUT}"
