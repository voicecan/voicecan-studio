# Voicecan Studio

[中文](README.zh-CN.md)

Voicecan Studio is an independently deployable and directly extensible example application built on Device Platform. This repository contains one demo application with two deployment profiles:

```text
Authorized Recording → Processor Stages → Traceable Artifacts → Scenario Pack → Human Review → Action Intent
```

Device Platform owns devices, recordings, authorization, and downloads; Studio does not duplicate those management capabilities. Starting from an authorized Recording, Studio performs processing, scenario projection, human review, action preview, and Courier execution. Each Recording is downloaded and transcribed only once. An upstream Revision change makes downstream results stale and prevents execution.

## Deployment profiles

| Profile | Model processing | Notification output | Default port |
| --- | --- | --- | ---: |
| External | HTTP ASR + HTTP Summary Processor | Optional Courier | `8811` |
| Local Full | Embedded Faster-Whisper + embedded Qwen3-4B GGUF Worker | Disabled by default; Courier can be enabled explicitly | `8815` |

Both profiles share the same scenario model, Web UI, and API. They differ only in the Processor selected by the Composition Root. Production entrypoints never include Fixture Processors.

## Built-in executable scenarios

| Scenario Pack | Default Recording attribute | Output |
| --- | ---: | --- |
| Voice Inbox | `0` | Memo classification, tags, tasks, and follow-up actions |
| Field Report | `1` | Field findings, severity, follow-up flags, and recommended actions |
| Meeting / Interview | `2` | Topics, decisions, and action items with source references |

Scenarios can be switched at any time without downloading or transcribing the Recording again. Every projection, edit, and review has a Revision. Actions must first produce a preview and then be explicitly confirmed by an operator.

## Quickstart

```bash
npm ci
npm run build
npm run start:external
```

Node.js `24.19.0` or a newer 24.x release is required. When External starts without configuration for the first time, open `http://127.0.0.1:8811` and configure Device Platform, ASR, Summary, and optional Courier on the Setup page. Configuration is validated before being written atomically with `0600` permissions.

Local Full on Linux:

```bash
cd studio
bash scripts/setup-local-linux.sh
bash scripts/run-local-linux.sh
```

On Windows, use `scripts/setup-local-windows.ps1` and `scripts/run-local-windows.ps1`. The installer prepares Node, uv, FFmpeg, liblc3, a pinned ASR model, and the pinned `Qwen/Qwen3-4B-GGUF@34778e…` Q4_K_M Summary model. Installed models are verified by size and SHA-256. Local Full requires at least 8 GiB RAM and 4 GiB of available disk space for the Summary model; 16 GiB RAM is recommended for long recordings.

Docker:

```bash
docker compose -f compose.external.yml up --build
docker compose -f compose.local-full.yml up --build
```

See the [operations runbook](studio/RUNBOOK.zh-CN.md) for complete installation and operations guidance. See the [architecture guide](docs/ARCHITECTURE.md) for architecture, extension points, and boundaries.

## Action execution and multiple channels

Studio uses the official Courier Node SDK, `@trycourier/courier@7.25.0`. Studio manages only Action Intents, delivery previews, idempotent submission, and Provider status synchronization. Courier owns email, SMS, push, chat, and inbox Integrations, Templates, Routing, Preferences, retries, and logs. This repository does not implement per-channel Transports or Adapters.

The current Scenario Revision must be confirmed by a human before execution. Default Payloads do not contain audio, download URLs, or full Transcripts. Local Full defaults to `NOTIFICATION_ENABLED=false`; strictly offline environments can still review, preview, and export Markdown.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run dev:external` | External development entrypoint |
| `npm run dev:local-full` | Local Full development entrypoint |
| `npm run doctor` | CLI Doctor |
| `npm run verify:sdk` | Verify reviewed Device Platform SDK artifacts |
| `npm run check:boundaries` | Check protocol-runtime, Fixture, and channel boundaries |
| `npm run check:architecture` | Check Capability-layer dependencies |
| `npm run ci` | Run the complete build and test gate |
| `npm run generate:scenario -- --name <id> --title <title>` | Generate and register a Scenario Pack |
| `npm run generate:processor -- --name <id> --kind asr\|summary` | Generate a Processor skeleton |
| `npm run generate:integration -- --name <id> --sdk <package>` | Generate an official-SDK Integration skeleton |
| `npm run generate:capability -- --name <id>` | Generate an internal Capability skeleton |
| `npm run context:ai -- --capability <id>` | Print the minimum safe AI context |
| `npm run verify:change -- --capability <id>` | Verify a targeted change |

## Adding or changing features with AI

Start with [studio/AGENTS.md](studio/AGENTS.md), [AI Start Here](studio/docs/ai-development/START-HERE.md), and the [Extension Catalog](studio/docs/ai-development/EXTENSION-CATALOG.md). Scenario Packs, Processor Stages, and Integrations are the preferred user-facing extension points; internal Capabilities exist only for stable transaction boundaries. An AI agent does not need to read the entire repository and must not read `.env`, real SQLite databases, audio, Transcripts, or Delivery Payloads.

## Security boundaries

- Use Device Platform only through the public `@voicecan/server-client`; do not access protocol-runtime internals, Platform databases, or object-storage credentials.
- Never log Application Tokens, Webhook Secrets, Processor/Courier Keys, temporary URLs, audio, or content.
- Create a Download Grant only after a task owns execution and its Processor, audio tools, and storage are healthy.
- All write APIs require an Operator Token; the browser stores it only in the current Session.
- The default listener is `127.0.0.1`. Use an authenticated TLS Ingress before exposing Studio publicly.

Report security issues privately through [SECURITY.md](SECURITY.md). See [SUPPORT.md](SUPPORT.md) for general help and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance. Third-party dependencies and pending license confirmations are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
