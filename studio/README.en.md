# Voicecan Studio

This directory contains the Voicecan Studio application. It reads authorized recordings from Device Platform and turns them into transcripts, summaries, scenario results, reviews, and action previews.

It provides two processing profiles:

- **External** uses HTTP ASR and Summary services, with optional Courier notifications.
- **Local Full** uses embedded Faster-Whisper and Qwen3-4B GGUF workers, with Courier disabled by default.

See the [repository README](../README.md) for product capabilities and [RUNBOOK.zh-CN.md](RUNBOOK.zh-CN.md) for installation and operations.

## Development

```bash
cd ..
npm ci
npm run build
npm run test
npm run dev:external
# or npm run dev:local-full
```

Use Scenario Packs, Processor Stages, and Integrations when extending user-facing workflows. See [AI development](docs/ai-development/START-HERE.md) for contributor guidance.
