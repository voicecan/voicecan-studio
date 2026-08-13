from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY = "Qwen/Qwen3-4B-GGUF"
REVISION = "34778e26c8fa5e8bc0daa2389a9f958cffb1aedd"
FILENAME = "Qwen3-4B-Q4_K_M.gguf"
SIZE = 2_497_280_256
SHA256 = "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5"


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the pinned Voicecan Studio local Summary model")
    parser.add_argument("--output", default="models/qwen3-4b-q4-k-m")
    parser.add_argument("--endpoint", default="https://huggingface.co")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(output).free < 4 * 1024**3:
        raise SystemExit("Local Summary installation requires at least 4 GiB free disk space")
    destination = output / FILENAME
    temporary = destination.with_suffix(".gguf.part")
    if not destination.exists() or destination.stat().st_size != SIZE or digest(destination) != SHA256:
        url = f"{args.endpoint.rstrip('/')}/{REPOSITORY}/resolve/{REVISION}/{FILENAME}?download=true"
        request = urllib.request.Request(url, headers={"User-Agent": "Voicecan-Studio/0.1"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as sink:
            shutil.copyfileobj(response, sink, length=1024 * 1024)
        if temporary.stat().st_size != SIZE or digest(temporary) != SHA256:
            temporary.unlink(missing_ok=True)
            raise SystemExit("Local Summary model size or SHA-256 verification failed")
        os.replace(temporary, destination)
    manifest = {
        "schema_version": "voicecan.local-summary-model.v1",
        "repository": REPOSITORY,
        "revision": REVISION,
        "license": "Apache-2.0",
        "registered_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "minimum_ram_bytes": 8 * 1024**3,
        "minimum_free_disk_bytes": 4 * 1024**3,
        "files": [{"path": FILENAME, "size": SIZE, "sha256": SHA256}],
    }
    manifest_path = output / "voicecan-model-manifest.json"
    temporary_manifest = manifest_path.with_suffix(".json.tmp")
    temporary_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary_manifest, manifest_path)
    print(f"Installed {REPOSITORY}@{REVISION} to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
