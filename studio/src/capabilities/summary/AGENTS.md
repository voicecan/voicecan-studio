# Summary Capability

Owns Summary Processor, chunk cache, Summary revisions, stale propagation, confirmation and Markdown export.

- Public Port: `SummaryProcessor`.
- Reads only a persisted Transcript revision; never downloads audio or calls ASR.
- Every conclusion must reference valid Transcript segment IDs.
- Transcript change makes the current Summary stale and clears confirmation.
- Verify with `npm run verify:change -- --capability summary`.
