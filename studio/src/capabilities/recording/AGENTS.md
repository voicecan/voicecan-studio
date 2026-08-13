# Recording Capability

Owns Device Platform reconciliation, Recording snapshots, audio lifecycle, Transcript revisions and playback.

- Public Port: Recording client and Transcription Processor.
- Data owner: Recording, transcription job, Transcript revisions, tombstones.
- May not depend on Summary or Delivery.
- A grant is created only after processor, audio tooling and storage checks pass.
- Verify with `npm run verify:change -- --capability recording`.
