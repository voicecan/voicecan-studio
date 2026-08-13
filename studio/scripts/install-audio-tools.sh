#!/usr/bin/env bash
# This file must remain LF-only because it runs inside Linux containers.
set -euo pipefail

SKIP_APT_UPDATE=0
for argument in "$@"; do
  case "$argument" in
    --skip-apt-update) SKIP_APT_UPDATE=1 ;;
    *) echo "Unknown argument: $argument" >&2; exit 2 ;;
  esac
done

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
FFMPEG_PACKAGE="ffmpeg${FFMPEG_APT_VERSION:+=$FFMPEG_APT_VERSION}"
LC3_PACKAGE="liblc3-tools${LIBLC3_TOOLS_APT_VERSION:+=$LIBLC3_TOOLS_APT_VERSION}"

package_version_matches() {
  local package="$1" expected_version="$2" installed_version
  installed_version="$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null)" || return 1
  [[ -z "$expected_version" || "$installed_version" == "$expected_version" ]]
}

if command -v ffmpeg >/dev/null 2>&1 &&
   command -v dlc3 >/dev/null 2>&1 &&
   package_version_matches ffmpeg "${FFMPEG_APT_VERSION:-}" &&
   package_version_matches liblc3-tools "${LIBLC3_TOOLS_APT_VERSION:-}" &&
   package_version_matches ca-certificates ''; then
  echo 'Existing FFmpeg and liblc3-tools installations match the requested versions; skipping APT installation.'
else
  if [[ "$SKIP_APT_UPDATE" -eq 0 ]]; then
    "${SUDO[@]}" apt-get update
  fi
  "${SUDO[@]}" apt-get install -y --no-install-recommends "$FFMPEG_PACKAGE" "$LC3_PACKAGE" ca-certificates
fi

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

