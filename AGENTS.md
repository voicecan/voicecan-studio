# AGENTS.md — Voicecan Studio Repository

This repository contains one application: `studio/`, with two deployment profiles.

- Runtime: Node.js `>=24.19 <25`, strict TypeScript, npm workspace.
- Production profiles: `external` and `local-full` only.
- Read `studio/AGENTS.md`, `studio/docs/ai-development/START-HERE.md`, and the target Scenario/Processor/Integration recipe before changing code.
- Consume Device Platform only through public REST/Webhook contracts and `@voicecan/server-client`. Never import private protocol runtime internals or access Platform databases/storage credentials.
- One Recording is downloaded/transcribed once. Downstream Artifacts and Scenario Packs consume persisted revisions.
- Courier is the notification platform. Do not implement channel transports or call downstream provider APIs.
- Application tokens, webhook secrets, temporary URLs, provider keys, transcripts, Delivery payloads and audio must never be logged.
- Temporary download URLs are never persisted. Create a grant only after a worker owns the job and processors/tooling are healthy.
- Recording format dispatch comes from `media`; unknown media follows the documented LC3 default and failed validation becomes `needs_attention`.
- Local Full ASR/Summary use verified local files and embedded workers. Do not add HTTP model processors, Voicecan Model Service, S3/FileID, relay gateways or public runtime model loading.
- Fixture processors exist only in tests and may not be selected by production entrypoints.

Commands:

```bash
npm ci
npm run build
npm test
npm run dev:external
npm run dev:local-full
npm run verify:change -- --capability <id>
```
