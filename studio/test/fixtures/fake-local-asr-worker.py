from __future__ import annotations

import argparse
import json
import os
import sys
import time


parser = argparse.ArgumentParser()
parser.add_argument("--model-path")
parser.add_argument("--model-version")
parser.add_argument("--device")
parser.add_argument("--compute-type")
parser.add_argument("--cpu-threads")
args = parser.parse_args()

if "VOICECAN_APPLICATION_TOKEN" in os.environ or "VOICECAN_WEBHOOK_SECRET" in os.environ:
    raise RuntimeError("Voicecan credentials leaked into local worker")

print(json.dumps({"type": "ready", "engine": "fake", "model": "fixture", "version": args.model_version, "device": args.device, "compute_type": args.compute_type}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if "crash" in request.get("audio_path", ""):
        os._exit(3)
    if "hang" in request.get("audio_path", ""):
        time.sleep(1)
    if "slow" in request.get("audio_path", ""):
        time.sleep(0.2)
    print(json.dumps({
        "id": request["id"],
        "ok": True,
        "language": "zh",
        "duration_ms": 2500,
        "segments": [
            {"id": "seg-0001", "start_ms": 0, "end_ms": 1200, "text": "完全本地", "speaker": None, "confidence": None},
            {"id": "seg-0002", "start_ms": 1200, "end_ms": 2500, "text": "独立转写", "speaker": None, "confidence": None},
        ],
    }, ensure_ascii=False), flush=True)
