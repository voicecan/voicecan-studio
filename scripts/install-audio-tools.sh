#!/usr/bin/env bash
# This file must remain LF-only because it runs inside Linux containers.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]] || ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Debian/Ubuntu Linux. Use install-audio-tools.ps1 on Windows." >&2
  exit 2
fi

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo "Run as root or install sudo first." >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
"${SUDO[@]}" apt-get update
FFMPEG_PACKAGE="ffmpeg${FFMPEG_APT_VERSION:+=$FFMPEG_APT_VERSION}"
LC3_PACKAGE="liblc3-tools${LIBLC3_TOOLS_APT_VERSION:+=$LIBLC3_TOOLS_APT_VERSION}"
"${SUDO[@]}" apt-get install -y --no-install-recommends "$FFMPEG_PACKAGE" "$LC3_PACKAGE" ca-certificates

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is not on PATH" >&2; exit 1; }
command -v dlc3 >/dev/null 2>&1 || { echo "dlc3 is not on PATH" >&2; exit 1; }
ffmpeg -hide_banner -filters 2>/dev/null | grep ' afftdn ' >/dev/null || { echo "Installed FFmpeg does not provide the afftdn filter" >&2; exit 1; }
dlc3 -h >/dev/null 2>&1 || { echo "dlc3 could not start" >&2; exit 1; }

if [[ -n "${FFMPEG_APT_VERSION:-}" ]] && [[ "$(dpkg-query -W -f='${Version}' ffmpeg)" != "$FFMPEG_APT_VERSION" ]]; then
  echo "Installed FFmpeg package does not match FFMPEG_APT_VERSION" >&2
  exit 1
fi
if [[ -n "${LIBLC3_TOOLS_APT_VERSION:-}" ]] && [[ "$(dpkg-query -W -f='${Version}' liblc3-tools)" != "$LIBLC3_TOOLS_APT_VERSION" ]]; then
  echo "Installed liblc3-tools package does not match LIBLC3_TOOLS_APT_VERSION" >&2
  exit 1
fi

"${SUDO[@]}" install -d -m 0755 /usr/local/share/voicecan
{
  sha256sum "$(command -v ffmpeg)"
  sha256sum "$(command -v dlc3)"
} | "${SUDO[@]}" tee /usr/local/share/voicecan/audio-tools.sha256 >/dev/null

echo "Audio tools ready: ffmpeg $(dpkg-query -W -f='${Version}' ffmpeg), liblc3-tools $(dpkg-query -W -f='${Version}' liblc3-tools)"
