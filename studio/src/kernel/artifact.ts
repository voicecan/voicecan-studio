import { createHash } from 'node:crypto';
import type { RecordingSnapshot, StudioArtifact } from '../shared/contracts.js';

export function createArtifact(input: {
  kind: StudioArtifact['kind'];
  schemaVersion: string;
  revision: number;
  recording: RecordingSnapshot;
  sourceSha256?: string | null;
  parents?: readonly StudioArtifact[];
  producer: { kind: string; version: string };
  payload: unknown;
}): StudioArtifact {
  const payloadHash = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
  return {
    id: createHash('sha256').update(`${input.recording.id}:${input.kind}:${input.revision}:${payloadHash}`).digest('hex'),
    kind: input.kind,
    schema_version: input.schemaVersion,
    revision: input.revision,
    source: { recording_id: input.recording.id, resource_version: input.recording.resource_version, sha256: input.sourceSha256 === undefined ? input.recording.sha256 : input.sourceSha256 },
    parent_artifact_ids: (input.parents ?? []).map((artifact) => artifact.id),
    producer: input.producer,
    payload_hash: payloadHash,
    created_at: new Date().toISOString(),
  };
}
