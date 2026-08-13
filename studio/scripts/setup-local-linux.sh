#!/usr/bin/env bash
# This file must remain LF-only because it runs on Linux.
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime"
DOWNLOAD_ROOT="$RUNTIME_ROOT/downloads"
NODE_VERSION="24.19.0"
UV_VERSION="0.10.2"
MODEL_ENDPOINT="${HF_ENDPOINT:-}"
NON_INTERACTIVE=0

for argument in "$@"; do
  case "$argument" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --model-endpoint=*) MODEL_ENDPOINT="${argument#*=}" ;;
    *) echo "Unknown argument: $argument" >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || { echo "This installer only supports Linux." >&2; exit 2; }
case "$(uname -m)" in
  x86_64) ARCH="x64"; NODE_ARCH="x64"; UV_TARGET="x86_64-unknown-linux-gnu"; NODE_SHA="14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647" ;;
  aarch64|arm64) ARCH="arm64"; NODE_ARCH="arm64"; UV_TARGET="aarch64-unknown-linux-gnu"; NODE_SHA="01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

if [[ "$EUID" -eq 0 ]]; then SUDO=();
elif command -v sudo >/dev/null 2>&1; then SUDO=(sudo);
else echo "Run as root or install sudo first." >&2; exit 2; fi

export DEBIAN_FRONTEND=noninteractive
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y --no-install-recommends ca-certificates curl xz-utils
bash "$PROJECT_ROOT/scripts/install-audio-tools.sh" --skip-apt-update

mkdir -p "$DOWNLOAD_ROOT"
download_and_verify() {
  local url="$1" destination="$2" sha256="$3"
  if [[ ! -f "$destination" ]]; then curl --fail --location --retry 3 --output "$destination" "$url"; fi
  printf '%s  %s\n' "$sha256" "$destination" | sha256sum --check --status || {
    echo "SHA-256 mismatch for $destination" >&2
    exit 1
  }
}

NODE_ASSET="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_ARCHIVE="$DOWNLOAD_ROOT/$NODE_ASSET"
NODE_HOME="$RUNTIME_ROOT/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
download_and_verify "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ASSET}" "$NODE_ARCHIVE" "$NODE_SHA"
if [[ ! -x "$NODE_HOME/bin/node" ]]; then tar -xJf "$NODE_ARCHIVE" -C "$RUNTIME_ROOT"; fi
[[ "$($NODE_HOME/bin/node --version)" == "v$NODE_VERSION" ]] || { echo "Private Node verification failed." >&2; exit 1; }

UV_ASSET="uv-${UV_TARGET}.tar.gz"
UV_ARCHIVE="$DOWNLOAD_ROOT/$UV_ASSET"
UV_CHECKSUM="$DOWNLOAD_ROOT/$UV_ASSET.sha256"
UV_HOME="$RUNTIME_ROOT/uv-v${UV_VERSION}-linux-${ARCH}"
if [[ ! -f "$UV_ARCHIVE" ]]; then curl --fail --location --retry 3 --output "$UV_ARCHIVE" "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET}"; fi
curl --fail --location --retry 3 --output "$UV_CHECKSUM" "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET}.sha256"
(cd "$DOWNLOAD_ROOT" && sha256sum --check "$(basename "$UV_CHECKSUM")")
if [[ ! -x "$UV_HOME/uv" ]]; then
  mkdir -p "$UV_HOME"
  tar -xzf "$UV_ARCHIVE" -C "$UV_HOME" --strip-components=1
fi
[[ "$($UV_HOME/uv --version)" == "uv $UV_VERSION"* ]] || { echo "Private uv verification failed." >&2; exit 1; }

cd "$PROJECT_ROOT"
"$NODE_HOME/bin/npm" ci
"$UV_HOME/uv" sync --project local-asr --python 3.12
AVAILABLE_RAM_KIB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
[[ "$AVAILABLE_RAM_KIB" -ge 8388608 ]] || { echo "Local Full requires at least 8 GiB RAM." >&2; exit 1; }
"$UV_HOME/uv" sync --project local-summary --python 3.12
SUMMARY_PYTHON="$PROJECT_ROOT/local-summary/.venv/bin/python"
if ! "$SUMMARY_PYTHON" -c 'from llama_cpp import llama_cpp; raise SystemExit(0 if llama_cpp.llama_supports_gpu_offload() else 1)' 2>/dev/null; then
  if command -v nvidia-smi >/dev/null 2>&1 && command -v nvcc >/dev/null 2>&1; then
    echo "Building the pinned local Summary runtime with CUDA support..."
    if ! CMAKE_ARGS='-DGGML_CUDA=on -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler' FORCE_CMAKE=1 "$UV_HOME/uv" pip install \
      --python "$SUMMARY_PYTHON" --reinstall-package llama-cpp-python --no-binary llama-cpp-python --no-cache \
      'llama-cpp-python==0.3.16'; then
      echo "Warning: CUDA Summary runtime build failed; Local Full will use the CPU fallback." >&2
      "$UV_HOME/uv" sync --project local-summary --python 3.12
    elif ! "$SUMMARY_PYTHON" -c 'from llama_cpp import llama_cpp; raise SystemExit(0 if llama_cpp.llama_supports_gpu_offload() else 1)' 2>/dev/null; then
      echo "Warning: the rebuilt Summary runtime does not expose GPU offload; Local Full will use the CPU fallback." >&2
    fi
  elif command -v nvidia-smi >/dev/null 2>&1; then
    echo "Warning: an NVIDIA GPU is present but nvcc was not found; install the CUDA Toolkit and rerun setup to enable Summary GPU offload." >&2
  fi
fi
MODEL_ARGS=(run --project local-asr python scripts/install-local-model.py --output models/faster-whisper-small)
if [[ -n "$MODEL_ENDPOINT" ]]; then MODEL_ARGS+=(--endpoint "$MODEL_ENDPOINT"); fi
"$UV_HOME/uv" "${MODEL_ARGS[@]}"
SUMMARY_ARGS=(run --project local-summary python scripts/install-local-summary-model.py --output models/qwen3-4b-q4-k-m)
if [[ -n "$MODEL_ENDPOINT" ]]; then SUMMARY_ARGS+=(--endpoint "$MODEL_ENDPOINT"); fi
"$UV_HOME/uv" "${SUMMARY_ARGS[@]}"

ENV_FILE="$PROJECT_ROOT/.env"
[[ -f "$ENV_FILE" ]] || cp "$PROJECT_ROOT/.env.example" "$ENV_FILE"
get_env() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }
remove_env() { sed -i "/^$1=/d" "$ENV_FILE"; }
set_env() { remove_env "$1"; printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; }
set_env FFMPEG_PATH "$(command -v ffmpeg)"
set_env LC3_DECODER_PATH "$(command -v dlc3)"
set_env LOCAL_ASR_MODEL_PATH "./models/faster-whisper-small"
set_env LOCAL_SUMMARY_MODEL_PATH "./models/qwen3-4b-q4-k-m"
set_env LOCAL_ASR_DEVICE "auto"
set_env LOCAL_ASR_COMPUTE_TYPE "default"
set_env LOCAL_SUMMARY_GPU_MODE "prefer"
set_env LOCAL_SUMMARY_GPU_LAYERS "-1"
set_env NOTIFICATION_ENABLED "false"
remove_env LOCAL_ASR_MODEL_VERSION
remove_env DEMO_FIXTURE_MODE
remove_env LOCAL_PROCESSOR_MODE

if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
  PLATFORM_URL="$(get_env VOICECAN_SERVER_URL)"
  APPLICATION_TOKEN="$(get_env VOICECAN_APPLICATION_TOKEN)"
  WEBHOOK_SECRET="$(get_env VOICECAN_WEBHOOK_SECRET)"
  [[ -n "$PLATFORM_URL" ]] || read -r -p "Device Platform URL (without /api/v1): " PLATFORM_URL
  [[ -n "$APPLICATION_TOKEN" ]] || { read -r -s -p "Application Token (vcd_app_...): " APPLICATION_TOKEN; echo; }
  [[ -n "$WEBHOOK_SECRET" ]] || { read -r -s -p "Webhook Secret (vce_...): " WEBHOOK_SECRET; echo; }
  [[ "$PLATFORM_URL" =~ ^https?://[^/]+ ]] || { echo "VOICECAN_SERVER_URL must be an absolute HTTP(S) URL." >&2; exit 1; }
  [[ "$APPLICATION_TOKEN" == vcd_app_* ]] || { echo "Application Token must start with vcd_app_." >&2; exit 1; }
  [[ "$WEBHOOK_SECRET" == vce_* ]] || { echo "Webhook Secret must start with vce_." >&2; exit 1; }
  set_env VOICECAN_SERVER_URL "${PLATFORM_URL%/}"
  set_env VOICECAN_APPLICATION_TOKEN "$APPLICATION_TOKEN"
  set_env VOICECAN_WEBHOOK_SECRET "$WEBHOOK_SECRET"
fi

"$NODE_HOME/bin/npm" run build
echo
echo "Voicecan Studio Local Full setup is complete."
echo "Start it with: bash scripts/run-local-linux.sh"
