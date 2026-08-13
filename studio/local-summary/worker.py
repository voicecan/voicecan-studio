from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def summary_schema(segment_ids: list[str]) -> dict[str, Any]:
    refs = {
        "type": "array",
        "minItems": 1,
        "items": {"type": "string", "enum": segment_ids},
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "title": {"type": "string", "minLength": 1},
            "overview": {"type": "string"},
            "topics": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "title": {"type": "string", "minLength": 1},
                        "summary": {"type": "string"},
                        "segment_refs": refs,
                    },
                    "required": ["title", "summary", "segment_refs"],
                },
            },
            "decisions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "text": {"type": "string", "minLength": 1},
                        "segment_refs": refs,
                    },
                    "required": ["text", "segment_refs"],
                },
            },
            "action_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "text": {"type": "string", "minLength": 1},
                        "assignee": {"type": ["string", "null"]},
                        "due_at": {"type": ["string", "null"]},
                        "segment_refs": refs,
                    },
                    "required": ["text", "assignee", "due_at", "segment_refs"],
                },
            },
        },
        "required": ["title", "overview", "topics", "decisions", "action_items"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Voicecan Studio local summary worker")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--gpu-mode", choices=("prefer", "require", "cpu"), default="prefer")
    parser.add_argument("--gpu-layers", type=int, default=-1)
    parser.add_argument("--context-size", type=int, default=8192)
    parser.add_argument("--max-tokens", type=int, default=1024)
    args = parser.parse_args()
    if args.context_size < 2048 or args.max_tokens < 128 or args.max_tokens >= args.context_size:
        raise ValueError("invalid context or output token limit")
    model_path = Path(args.model_path).resolve()
    manifest = json.loads((model_path / "voicecan-model-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != "voicecan.local-summary-model.v1" or f"{manifest['repository']}@{manifest['revision']}" != args.model_version:
        raise RuntimeError("local summary manifest does not match configured immutable version")
    model_files = [model_path / item["path"] for item in manifest["files"] if str(item["path"]).endswith(".gguf")]
    if len(model_files) != 1:
        raise RuntimeError("manifest must contain exactly one GGUF model")

    from llama_cpp import Llama, llama_cpp

    gpu_backend_available = bool(llama_cpp.llama_supports_gpu_offload())
    use_gpu = args.gpu_mode != "cpu" and args.gpu_layers != 0 and gpu_backend_available
    if args.gpu_mode == "require" and not use_gpu:
        raise RuntimeError("GPU offload was required but the llama.cpp runtime has no GPU backend")
    actual_device = "gpu" if use_gpu else "cpu"
    try:
        model = Llama(
            model_path=str(model_files[0]),
            n_ctx=args.context_size,
            n_gpu_layers=args.gpu_layers if use_gpu else 0,
            flash_attn=use_gpu,
            verbose=False,
        )
    except Exception:
        if args.gpu_mode != "prefer" or not use_gpu:
            raise
        actual_device = "cpu"
        model = Llama(model_path=str(model_files[0]), n_ctx=args.context_size, n_gpu_layers=0, verbose=False)
    emit({
        "type": "ready",
        "engine": "llama-cpp-python",
        "model": model_path.name,
        "version": args.model_version,
        "device": actual_device,
        "gpu_layers": args.gpu_layers if actual_device == "gpu" else 0,
        "gpu_backend_available": gpu_backend_available,
        "context_size": args.context_size,
        "max_tokens": args.max_tokens,
    })
    for line in sys.stdin:
        request_id = "unknown"
        try:
            request = json.loads(line)
            request_id = str(request["id"])
            if request.get("command") != "summarize":
                raise ValueError("unsupported command")
            transcript = request["transcript"]
            segments = [
                {
                    "id": item["id"],
                    "start_ms": item["start_ms"],
                    "end_ms": item["end_ms"],
                    "speaker": item.get("speaker"),
                    "text": item["text"],
                }
                for item in transcript["segments"]
                if str(item.get("text", "")).strip()
            ]
            if not segments:
                raise ValueError("SUMMARY_INPUT_EMPTY")
            schema = summary_schema([item["id"] for item in segments])
            prompt = (
                "Create a concise traceable meeting summary using exactly the supplied JSON schema. "
                "Every topic, decision, and action item must cite one or more exact segment ids. "
                "Use an empty array when there are no decisions or action items. due_at must be an ISO-8601 "
                "datetime or null. Any explicit commitment, assignment, owner, or deadline must become an action item. "
                "Do not invent facts. Return JSON only.\nTranscript:\n"
                + json.dumps({"recording_id": transcript["recording_id"], "segments": segments}, ensure_ascii=False)
                + "\n/no_think"
            )
            response = model.create_chat_completion(
                messages=[{"role": "system", "content": "Return only a concise JSON summary. Do not reveal reasoning."}, {"role": "user", "content": prompt}],
                temperature=0.1,
                response_format={"type": "json_object", "schema": schema},
                max_tokens=args.max_tokens,
            )
            choice = response["choices"][0]
            if choice.get("finish_reason") == "length":
                raise RuntimeError("SUMMARY_OUTPUT_LIMIT")
            content = choice["message"]["content"]
            if not isinstance(content, str):
                raise RuntimeError("SUMMARY_OUTPUT_MISSING")
            content = content.encode("utf-8", errors="replace").decode("utf-8")
            summary = json.loads(content)
            summary["schema_version"] = "demo.meeting-summary.v1"
            summary["recording_id"] = transcript["recording_id"]
            summary["model"] = {"provider": "local-llama-cpp", "model": model_path.name, "prompt_version": request.get("prompt_version", "meeting-v1")}
            emit({"id": request_id, "ok": True, "summary": summary})
        except Exception as error:
            emit({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
