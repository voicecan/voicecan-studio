# Delivery Capability

Owns Action intents, previews, Notification targets, Delivery intents, idempotent provider submission, status/history sync and audit.

- Public Port: `NotificationProvider`.
- Only an Action bound to the current confirmed Scenario revision can be submitted.
- Payload excludes audio, temporary URLs and full Transcript by default.
- Courier SDK types stay in infrastructure. Never call Courier or channel HTTP APIs directly.
- New channels are Courier configuration; do not add channel adapters.
- Verify with `npm run verify:change -- --capability delivery`.
