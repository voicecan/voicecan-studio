from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def register_model(repository: str, revision: str, model_path: Path) -> Path:
    if not re.fullmatch(r"[a-fA-F0-9]{40,64}", revision):
        raise ValueError("revision must be an immutable 40-64 character hexadecimal value")
    model_path = model_path.resolve()
    if not model_path.is_dir():
        raise ValueError("model path must be an existing local directory")
    required = [model_path / "model.bin", model_path / "config.json", model_path / "tokenizer.json"]
    missing = [path.name for path in required if not path.is_file()]
    if missing:
        raise ValueError(f"model directory is missing required files: {', '.join(missing)}")

    manifest_path = model_path / "voicecan-model-manifest.json"
    files = []
    for path in sorted(item for item in model_path.rglob("*") if item.is_file() and item != manifest_path):
        relative = path.relative_to(model_path).as_posix()
        files.append({"path": relative, "size": path.stat().st_size, "sha256": sha256(path)})
    manifest = {
        "schema_version": "voicecan.local-asr-model.v1",
        "repository": repository,
        "revision": revision.lower(),
        "registered_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "files": files,
    }
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)
    return manifest_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Register and hash a local CTranslate2 Whisper model for Voicecan Studio Local")
    parser.add_argument("--repository", required=True, help="Logical model source, for example Systran/faster-whisper-small")
    parser.add_argument("--revision", required=True, help="Immutable 40-64 character hexadecimal revision")
    parser.add_argument("--model-path", required=True, help="Existing local CTranslate2 model directory")
    args = parser.parse_args()
    model_path = Path(args.model_path).resolve()
    try:
        manifest_path = register_model(args.repository, args.revision, model_path)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    print(f"Local model registered at {model_path}")
    print(f"Model version: {args.repository}@{args.revision.lower()}")
    print(f"Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
