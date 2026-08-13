export type { MeetingSummaryV1, SummaryChunk, SummaryRevision, SummaryState } from '../../../shared/contracts.js';

export const SUMMARY_INVARIANTS = Object.freeze([
  'a Summary revision binds one Transcript revision and content hash',
  'stale Summary revisions cannot feed a current Scenario result',
  'every conclusion references a valid Transcript segment',
]);
