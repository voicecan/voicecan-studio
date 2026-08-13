from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Voicecan Studio Local Full Faster-Whisper worker")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--cpu-threads", type=int, default=0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    model_path = Path(args.model_path).resolve()
    if not model_path.exists():
        raise RuntimeError("local model path does not exist")
    manifest_path = model_path / "voicecan-model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_version = f"{manifest['repository']}@{manifest['revision']}"
    if manifest.get("schema_version") != "voicecan.local-asr-model.v1" or manifest_version != args.model_version:
        raise RuntimeError("local model manifest does not match configured immutable version")

    import ctranslate2
    from faster_whisper import WhisperModel

    requested_device = args.device
    actual_device = requested_device
    actual_compute_type = args.compute_type
    if requested_device == "auto":
        actual_device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        if args.compute_type == "default":
            actual_compute_type = "float16" if actual_device == "cuda" else "int8"

    try:
        model = WhisperModel(
            str(model_path),
            device=actual_device,
            compute_type=actual_compute_type,
            cpu_threads=args.cpu_threads,
            local_files_only=True,
        )
    except Exception:
        if requested_device != "auto" or actual_device != "cuda":
            raise
        actual_device = "cpu"
        actual_compute_type = "int8" if args.compute_type == "default" else args.compute_type
        model = WhisperModel(
            str(model_path),
            device=actual_device,
            compute_type=actual_compute_type,
            cpu_threads=args.cpu_threads,
            local_files_only=True,
        )
    emit({
        "type": "ready",
        "engine": "faster-whisper",
        "model": model_path.name,
        "version": args.model_version,
        "device": actual_device,
        "compute_type": actual_compute_type,
    })

    for line in sys.stdin:
        request_id = "unknown"
        try:
            request = json.loads(line)
            request_id = str(request["id"])
            if request.get("command") != "transcribe":
                raise ValueError("unsupported command")
            audio_path = Path(str(request["audio_path"])).resolve()
            if not audio_path.is_file():
                raise ValueError("audio file does not exist")
            language_hint = request.get("language_hint") or None
            generated, info = model.transcribe(
                str(audio_path),
                language=language_hint,
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=True,
            )
            segments = []
            for index, segment in enumerate(generated, start=1):
                text = segment.text.strip()
                if not text:
                    continue
                start_ms = max(0, round(segment.start * 1000))
                end_ms = max(start_ms + 1, round(segment.end * 1000))
                segments.append({
                    "id": f"seg-{index:04d}",
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "text": text,
                    "speaker": None,
                    "confidence": None,
                })
            duration_ms = segments[-1]["end_ms"] if segments else None
            emit({
                "id": request_id,
                "ok": True,
                "language": getattr(info, "language", None),
                "duration_ms": duration_ms,
                "segments": segments,
            })
        except Exception as error:
            emit({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
