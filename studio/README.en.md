# VoiceCan Studio

This directory contains the repository's only application. External and Local Full are deployment profiles of the same VoiceCan Studio codebase:

```text
Recording → Audio → Transcript Revision → Summary Revision → Confirmation → Delivery
```

It ships in two profiles only: **External** (HTTP ASR and Summary processors) and **Local Full** (embedded Faster-Whisper and Qwen3-4B GGUF workers). Courier notification egress is optional and disabled by default in Local Full.

See [README.md](README.md) for development and [RUNBOOK.zh-CN.md](RUNBOOK.zh-CN.md) for the complete operator runbook.
