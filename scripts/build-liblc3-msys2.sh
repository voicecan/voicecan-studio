#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:?target directory is required}"
LIBLC3_COMMIT="96a3af0beb5487aca3b98a4b992a539a1f6d80d1"
BUILD_DIR="$(mktemp -d -t voicecan-liblc3-XXXXXX)"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

pacman -Sy --needed --noconfirm ca-certificates git make mingw-w64-ucrt-x86_64-gcc
MSYS2_CA_BUNDLE=/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem
[[ -r "$MSYS2_CA_BUNDLE" ]] || { echo "MSYS2 CA bundle is unavailable: $MSYS2_CA_BUNDLE" >&2; exit 1; }
# MSYS2 Git supports OpenSSL only. Override Windows Git's inherited
# schannel backend and Windows-form CA path for this clone.
git -c http.sslBackend=openssl -c http.sslCAInfo="$MSYS2_CA_BUNDLE" \
  clone https://github.com/google/liblc3.git "$BUILD_DIR/liblc3"
git -C "$BUILD_DIR/liblc3" config http.sslBackend openssl
git -C "$BUILD_DIR/liblc3" config http.sslCAInfo "$MSYS2_CA_BUNDLE"
git -c http.sslBackend=openssl -c http.sslCAInfo="$MSYS2_CA_BUNDLE" \
  -C "$BUILD_DIR/liblc3" checkout --detach "$LIBLC3_COMMIT"
# The pinned upstream Makefile emits liblc3.so even for MinGW, while the
# MinGW linker behind `-llc3` looks for an import/static library. Build the
# decoder as one self-contained executable so it has no sidecar DLL/import
# library requirement on Windows.
gcc -O3 -std=c11 -Wall -Wextra -Wdouble-promotion -Wvla -pedantic \
  -ffast-math -I"$BUILD_DIR/liblc3/include" \
  "$BUILD_DIR/liblc3/tools/dlc3.c" \
  "$BUILD_DIR/liblc3/tools/lc3bin.c" \
  "$BUILD_DIR/liblc3/tools/wave.c" \
  "$BUILD_DIR/liblc3"/src/*.c -lm -o "$BUILD_DIR/liblc3/dlc3.exe"
mkdir -p "$TARGET_DIR"
cp "$BUILD_DIR/liblc3/dlc3.exe" "$TARGET_DIR/dlc3.exe"
"$TARGET_DIR/dlc3.exe" -h >/dev/null 2>&1
