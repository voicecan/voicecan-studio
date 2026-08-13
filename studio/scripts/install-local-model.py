from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[1]
LOCAL_ASR_ROOT = PROJECT_ROOT / "local-asr"
sys.path.insert(0, str(LOCAL_ASR_ROOT))

from register_model import register_model, sha256  # noqa: E402

MODEL_REPOSITORY = "Systran/faster-whisper-small"
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
DEFAULT_ENDPOINT = "https://huggingface.co"
MODEL_ARTIFACTS = {
    "config.json": (2370, "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828"),
    "model.bin": (483546902, "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"),
    "tokenizer.json": (2203239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
    "vocabulary.txt": (459861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
}


def artifact_is_valid(path: Path, expected_size: int, expected_sha256: str) -> bool:
    return path.is_file() and path.stat().st_size == expected_size and sha256(path) == expected_sha256


def download_artifact(endpoint: str, name: str, destination: Path) -> None:
    expected_size, expected_sha256 = MODEL_ARTIFACTS[name]
    url = f"{endpoint.rstrip('/')}/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/{name}"
    print(f"Downloading {name} from the pinned model revision...", flush=True)
    last_error: BaseException | None = None
    for attempt in range(1, 4):
        temporary = destination.with_suffix(destination.suffix + ".part")
        temporary.unlink(missing_ok=True)
        digest = hashlib.sha256()
        received = 0
        try:
            request = Request(url, headers={"User-Agent": "Voicecan-Studio/0.1"})
            with urlopen(request, timeout=120) as response, temporary.open("wb") as target:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
            if received != expected_size or digest.hexdigest() != expected_sha256:
                raise RuntimeError(
                    f"integrity mismatch for {name}: received {received} bytes, sha256={digest.hexdigest()}"
                )
            temporary.replace(destination)
            print(f"Downloaded and verified {name} ({received} bytes)", flush=True)
            return
        except (HTTPError, URLError, OSError, RuntimeError) as error:
            temporary.unlink(missing_ok=True)
            last_error = error
            print(f"Download attempt {attempt}/3 failed for {name}: {error}", file=sys.stderr, flush=True)
    raise RuntimeError(f"failed to download {name} after 3 attempts") from last_error


def verify_existing(path: Path) -> bool:
    manifest_path = path / "voicecan-model-manifest.json"
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if (
        manifest.get("schema_version") != "voicecan.local-asr-model.v1"
        or manifest.get("repository") != MODEL_REPOSITORY
        or manifest.get("revision") != MODEL_REVISION
        or not isinstance(manifest.get("files"), list)
    ):
        return False
    for name, (expected_size, expected_sha256) in MODEL_ARTIFACTS.items():
        if not artifact_is_valid(path / name, expected_size, expected_sha256):
            return False
    for item in manifest["files"]:
        if not isinstance(item, dict):
            return False
        file_path = (path / str(item.get("path", ""))).resolve()
        if path.resolve() not in file_path.parents or not file_path.is_file():
            return False
        if file_path.stat().st_size != item.get("size") or sha256(file_path) != item.get("sha256"):
            return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the pinned local Faster-Whisper model")
    parser.add_argument("--output", default=str(PROJECT_ROOT / "models" / "faster-whisper-small"))
    parser.add_argument("--endpoint", default=None, help="Optional Hugging Face-compatible endpoint")
    parser.add_argument("--dry-run", action="store_true", help="Resolve the pinned snapshot without downloading it")
    args = parser.parse_args()

    output = Path(args.output).resolve()
    if args.dry_run:
        print(f"Pinned model: {MODEL_REPOSITORY}@{MODEL_REVISION}")
        print(f"Endpoint: {args.endpoint or DEFAULT_ENDPOINT}")
        print(f"Files: {len(MODEL_ARTIFACTS)}")
        print(f"Download size: {sum(size for size, _ in MODEL_ARTIFACTS.values())} bytes")
        return 0

    if verify_existing(output):
        print(f"Local model is already installed and verified: {output}")
        return 0
    if output.exists():
        raise SystemExit(
            f"Model destination exists but is incomplete or invalid: {output}. "
            "Move it aside and rerun setup; the installer will not overwrite it."
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-install-", dir=output.parent))
    try:
        endpoint = args.endpoint or DEFAULT_ENDPOINT
        for name in MODEL_ARTIFACTS:
            download_artifact(endpoint, name, staging / name)
        register_model(MODEL_REPOSITORY, MODEL_REVISION, staging)
        if not verify_existing(staging):
            raise RuntimeError("Downloaded model failed the generated manifest verification")
        staging.replace(output)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise

    print(f"Installed local model: {output}")
    print(f"Model version: {MODEL_REPOSITORY}@{MODEL_REVISION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
