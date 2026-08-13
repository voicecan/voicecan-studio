export type { RecordingSnapshot, Revision, TranscriptV1 } from '../../../shared/contracts.js';

export const RECORDING_INVARIANTS = Object.freeze([
  'one aggregate per authorized Recording',
  'one current Transcript revision',
  'download grants are created only after readiness checks',
]);
