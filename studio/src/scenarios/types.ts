import type { MeetingSummaryV1, RecordingSnapshot, ScenarioManifest, ScenarioResultV1, TranscriptV1 } from '../shared/contracts.js';

export type ScenarioBuildInput = {
  recording: RecordingSnapshot;
  transcript: TranscriptV1;
  transcriptRevision: number;
  summary: MeetingSummaryV1;
  summaryRevision: number;
};

export type ScenarioDefinition = {
  manifest: ScenarioManifest;
  build(input: ScenarioBuildInput): ScenarioResultV1;
};
