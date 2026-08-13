from __future__ import annotations

import argparse
import json
import os
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--model-path", required=True)
parser.add_argument("--model-version", required=True)
parser.add_argument("--gpu-mode", choices=("prefer", "require", "cpu"), default="prefer")
parser.add_argument("--gpu-layers", type=int, default=-1)
parser.add_argument("--context-size", type=int, default=8192)
parser.add_argument("--max-tokens", type=int, default=1024)
args = parser.parse_args()
if os.environ.get("VOICECAN_APPLICATION_TOKEN") or os.environ.get("COURIER_API_KEY"):
    raise RuntimeError("secret reached local summary worker")
print(json.dumps({"type": "ready", "engine": "fake", "model": "fixture", "version": args.model_version, "device": "fixture", "gpu_layers": args.gpu_layers, "gpu_backend_available": False, "context_size": args.context_size, "max_tokens": args.max_tokens}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    transcript = request["transcript"]
    first = transcript["segments"][0]
    summary = {
        "schema_version": "demo.meeting-summary.v1", "recording_id": transcript["recording_id"],
        "title": "完全本地会议纪要", "overview": first["text"],
        "topics": [{"title": "本地主题", "summary": first["text"], "segment_refs": [first["id"]]}],
        "decisions": [{"text": "保持本地处理", "segment_refs": [first["id"]]}],
        "action_items": [{"text": "完成离线验收", "assignee": None, "due_at": None, "segment_refs": [first["id"]]}],
        "model": {"provider": "local-llama-cpp", "model": "fixture", "prompt_version": request["prompt_version"]},
    }
    print(json.dumps({"id": request["id"], "ok": True, "summary": summary}, ensure_ascii=False), flush=True)
