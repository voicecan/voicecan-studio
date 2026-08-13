#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac
NODE="$PROJECT_ROOT/.runtime/node-v24.19.0-linux-$NODE_ARCH/bin/node"
[[ -x "$NODE" ]] || { echo "Private Node runtime is missing. Run scripts/setup-local-linux.sh first." >&2; exit 1; }
[[ -f "$PROJECT_ROOT/.env" ]] || { echo ".env is missing. Run scripts/setup-local-linux.sh first." >&2; exit 1; }
cd "$PROJECT_ROOT"
echo "Voicecan Studio - Local Full"
echo "Project: $PROJECT_ROOT"
echo "Node: $($NODE --version) (project-private runtime)"
echo "Environment: $PROJECT_ROOT/.env"
echo "Starting the service. Platform reconciliation and local model loading may take some time."
echo "The exact UI and health-check URLs will be printed when the HTTP server is listening."
echo "Press Ctrl+C to stop."
echo
exec "$NODE" --env-file=.env dist/main-local.js
