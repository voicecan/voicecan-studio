# Scenario Capability

Owns Scenario selection, pure projection, Scenario Revision, stale propagation, Artifact lineage and human confirmation.

- Scenario Packs stay pure and vendor independent under `src/scenarios/`.
- A Result binds the current Transcript and Summary revisions and only references existing segments.
- Upstream changes invalidate confirmation and pending Action intents.
- Verify with `npm run verify:change -- --capability scenario`.
