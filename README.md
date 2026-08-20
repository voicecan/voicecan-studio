# Voicecan Studio

[中文](README.zh-CN.md)

Voicecan Studio is a self-hosted application for turning authorized Voicecan recordings into organized, reviewable work. It connects to [Voicecan Device Platform](https://github.com/voicecan/device-platform), processes each recording, presents the result in a simple web interface, and helps an operator decide what to do next.

```text
Recording → Transcript → Summary → Scenario result → Review → Action
```

## What you can do

- Process an authorized recording once and keep the transcript, summary, scenario result, review, and action linked together.
- Switch between built-in workflows without downloading or transcribing the same recording again.
- Review results with source references, edit them, and confirm an action only after the current result has been checked.
- Preview and submit notifications through Courier with retry-safe delivery and provider status updates.
- Run with cloud or self-managed processors, or keep processing local with the embedded Local Full profile.
- Add your own Scenario Packs, processors, and third-party integrations.

## Built-in workflows

| Workflow | Best for | Typical result |
| --- | --- | --- |
| Voice Inbox | Personal notes and incoming voice messages | Categories, tags, tasks, and follow-up actions |
| Field Report | Site visits and field work | Findings, severity, follow-up flags, and recommendations |
| Meeting / Interview | Conversations and interviews | Topics, decisions, and action items with source references |

## Choose a profile

| Profile | How processing works | Notifications | Best for |
| --- | --- | --- | --- |
| External | Connects to HTTP ASR and Summary services | Optional Courier | Existing model services or a shared deployment |
| Local Full | Runs embedded Faster-Whisper and Qwen3-4B GGUF workers | Off by default; can be enabled | Local or offline processing |

Both profiles use the same web interface and workflow model. You can change the profile without changing the user-facing workflow.

## Quick start

Requirements: Node.js `24.19.0` or a newer 24.x release, plus a running Device Platform instance.

```bash
npm ci
npm run build
npm run start:external
```

On the first External start, open `http://127.0.0.1:8811` and enter the Device Platform, ASR, Summary, and optional Courier settings in the Setup page.

To run Local Full on Linux:

```bash
cd studio
bash scripts/setup-local-linux.sh
bash scripts/run-local-linux.sh
```

On Windows, use `scripts/setup-local-windows.ps1` and `scripts/run-local-windows.ps1`. The installer prepares the local audio tools and models for you.

Docker users can start either profile with:

```bash
docker compose -f compose.external.yml up --build
docker compose -f compose.local-full.yml up --build
```

## One-prompt AI setup

Copy the prompt below into your AI coding or automation assistant to set up Studio for a recording workflow:

```text
You are setting up Voicecan Studio from https://github.com/voicecan/voicecan-studio in the current environment.

Use the current user request as the setup or integration goal. Before acting, read and follow the repository guidance and the relevant extension recipe:

https://github.com/voicecan/voicecan-studio/blob/main/AGENTS.md
https://github.com/voicecan/voicecan-studio/blob/main/studio/AGENTS.md
https://github.com/voicecan/voicecan-studio/blob/main/studio/docs/ai-development/START-HERE.md
https://github.com/voicecan/voicecan-studio/blob/main/studio/docs/ai-development/EXTENSION-CATALOG.md
https://github.com/voicecan/voicecan-studio/tree/main/studio/docs/ai-development/recipes

If Device Platform access is needed, also read the relevant Skills in https://github.com/voicecan/device-platform/tree/main/skills.

Inspect the environment and any existing Studio process first. Follow the repository guidance for profile selection, configuration, test data, credentials, workflow verification, and extension scope. Use the public Device Platform contracts and do not duplicate device management.

Never read or expose secrets, production recordings, audio, transcripts, delivery payloads, private protocol sources, or model files. Ask before external network changes, sending notifications, changing retention, deleting data, creating credentials, or modifying an existing deployment. At the end, report the profile, local URL, commands, checks, manual steps, configuration changes, and rollback plan without secrets or user content.
```

## Privacy and action safety

Studio keeps the recording workflow separate from device management: Device Platform remains the source of device identity, recording authorization, and downloads. Action execution is a two-step flow—preview first, then explicit operator confirmation. Default action payloads do not include audio, download URLs, or full transcripts.

Local Full keeps Courier disabled by default, so you can review, preview, and export Markdown in a local environment without sending notifications.

## Extend Studio

The preferred extension points are:

- **Scenario Packs** for new user workflows and result formats.
- **Processor Stages** for ASR or summary providers.
- **Integrations** for supported third-party action services.

See the [architecture guide](docs/ARCHITECTURE.md), [AI development guide](studio/docs/ai-development/START-HERE.md), and [operations runbook](studio/RUNBOOK.zh-CN.md).

## More information

- [Public release checklist](docs/PUBLIC_RELEASE_CHECKLIST.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
