# AGENTS.md — VoiceCan Studio

VoiceCan Studio is the only application in this repository. Production has two profiles: `external` and `local-full`.

Read `docs/ai-development/START-HERE.md` and the target Scenario/Processor/Integration recipe before editing. Read a Capability's `AGENTS.md` only when changing that internal transaction boundary.

## Boundaries

- Device Platform is accessed only through `@voicecan/server-client` and public contracts.
- One Recording may be downloaded and transcribed once. Artifacts preserve lineage; Scenario and Action revisions must bind to current upstream revisions.
- Domain code never imports Node infrastructure, SQLite, Courier, HTTP or UI.
- Courier is the first Notification Provider. Do not add email, SMS, Slack, Teams or other channel adapters.
- Local Full ASR and Summary use verified local files and embedded workers; no HTTP model services or public model download.
- Fixture Processors belong only in tests and cannot be selected by a production entrypoint.
- Never log tokens, webhook secrets, Courier keys, audio, Transcript text or Delivery payloads.

## Commands

```bash
npm run build
npm test
npm run doctor
npm run context:ai -- --capability recording
npm run verify:change -- --capability recording
```

Generated internal catalog: `docs/ai-development/CAPABILITY-CATALOG.md`. Public extension points are documented in `docs/ai-development/EXTENSION-CATALOG.md`.
