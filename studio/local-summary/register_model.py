from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            sha.update(chunk)
    return sha.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Register an immutable local GGUF summary model")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--model-path", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-fA-F0-9]{40,64}", args.revision):
        raise SystemExit("revision must be an immutable 40-64 character hexadecimal value")
    root = Path(args.model_path).resolve()
    gguf = list(root.glob("*.gguf"))
    if len(gguf) != 1:
        raise SystemExit("model directory must contain exactly one GGUF file")
    manifest_path = root / "voicecan-model-manifest.json"
    files = [{"path": item.relative_to(root).as_posix(), "size": item.stat().st_size, "sha256": digest(item)} for item in sorted(root.rglob("*")) if item.is_file() and item != manifest_path]
    manifest = {"schema_version": "voicecan.local-summary-model.v1", "repository": args.repository, "revision": args.revision.lower(), "registered_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "files": files}
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)
    print(f"Local summary model registered: {args.repository}@{args.revision.lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
