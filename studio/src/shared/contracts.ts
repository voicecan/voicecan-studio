import { createHash } from 'node:crypto';
import type { RecordingMediaDescriptor, RecordingTiming } from '@voicecan/contracts';

export const JOB_STATES = [
  'received', 'waiting_for_recording', 'downloading', 'validating', 'normalizing',
  'processing', 'post_processing', 'completed', 'needs_attention', 'failed', 'canceled',
] as const;

export type JobState = typeof JOB_STATES[number];

export type TranscriptSegmentV1 = {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
  confidence: number | null;
};

export type TranscriptV1 = {
  schema_version: 'demo.transcript.v1';
  recording_id: string;
  language: string | null;
  duration_ms: number | null;
  text: string;
  segments: TranscriptSegmentV1[];
  processor: { provider: string; model: string; version: string | null };
};

export type TranscriptEnvelopeV1 = {
  schema_version: 'demo.transcript-envelope.v1';
  recording_id: string;
  source_job_id: string;
  source_recording_resource_version: number;
  revision: number;
  content_hash: string;
  created_at: string;
  transcript: TranscriptV1;
};

export type MeetingSummaryV1 = {
  schema_version: 'demo.meeting-summary.v1';
  recording_id: string;
  title: string;
  overview: string;
  topics: Array<{ title: string; summary: string; segment_refs: string[] }>;
  decisions: Array<{ text: string; segment_refs: string[] }>;
  action_items: Array<{ text: string; assignee: string | null; due_at: string | null; segment_refs: string[] }>;
  model: { provider: string; model: string; prompt_version: string };
};

export type RecordingSnapshot = {
  id: string;
  device_id: string;
  attribute: number;
  sha256: string | null;
  media: RecordingMediaDescriptor;
  timing: RecordingTiming;
  source_firmware_version: string | null;
  resource_version: number;
};

export type Revision<T> = {
  revision: number;
  value: T;
  edited_at: string;
  edited_by: string;
  note: string | null;
};

export const SUMMARY_STATES = ['not_requested', 'queued', 'processing', 'completed', 'failed', 'stale', 'skipped'] as const;
export type SummaryState = typeof SUMMARY_STATES[number];

export type SummaryRevision = {
  revision: number;
  source_transcript_revision: number;
  source_transcript_hash: string;
  input_key: string;
  value: MeetingSummaryV1;
  kind: 'generated' | 'edited';
  created_at: string;
  created_by: string;
  note: string | null;
};

export type SummaryChunk = {
  source_transcript_revision: number;
  index: number;
  input_hash: string;
  summary: MeetingSummaryV1;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type StudioArtifact = {
  id: string;
  kind: 'transcript' | 'summary' | 'scenario-result';
  schema_version: string;
  revision: number;
  source: {
    recording_id: string;
    resource_version: number;
    sha256: string | null;
  };
  parent_artifact_ids: string[];
  producer: { kind: string; version: string };
  payload_hash: string;
  created_at: string;
};

export type ScenarioFieldDefinition = {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'string-list';
  required: boolean;
};

export type ScenarioManifest = {
  id: string;
  version: string;
  title: string;
  description: string;
  default_for_attributes: number[];
  processor_stages: string[];
  fields: ScenarioFieldDefinition[];
  allowed_actions: Array<'courier.notify'>;
};

export type ScenarioResultV1 = {
  schema_version: 'studio.scenario-result.v1';
  scenario_id: string;
  scenario_version: string;
  recording_id: string;
  title: string;
  overview: string;
  values: Record<string, JsonValue>;
  sections: Array<{
    id: string;
    title: string;
    items: Array<{ text: string; segment_refs: string[] }>;
  }>;
  actions: Array<{
    id: string;
    title: string;
    description: string;
    assignee: string | null;
    due_at: string | null;
    priority: 'low' | 'medium' | 'high';
    segment_refs: string[];
  }>;
  source_transcript_revision: number;
  source_summary_revision: number;
};

export type ScenarioRevision = {
  revision: number;
  value: ScenarioResultV1;
  kind: 'generated' | 'edited';
  created_at: string;
  created_by: string;
  note: string | null;
};

export type ScenarioConfirmation = {
  scenario_revision: number;
  confirmed_at: string;
  confirmed_by: string;
  note: string | null;
};

export type StudioScenarioNotificationV1 = {
  schema_version: 'studio.scenario-notification.v1';
  recording_id: string;
  scenario_id: string;
  scenario_revision: number;
  title: string;
  overview: string;
  values: Record<string, JsonValue>;
  actions: Array<{ title: string; description: string; assignee: string | null; due_at: string | null; priority: 'low' | 'medium' | 'high' }>;
  studio_url: string | null;
  confirmed_at: string;
  confirmed_by: string;
};

export type ActionIntent = {
  id: string;
  kind: 'courier.notify';
  scenario_id: string;
  scenario_revision: number;
  target: NotificationTarget;
  preview: StudioScenarioNotificationV1;
  idempotency_key: string;
  state: 'draft' | 'executing' | 'submitted' | 'completed' | 'failed' | 'canceled';
  delivery_id: string | null;
  created_at: string;
  updated_at: string;
  error_code: string | null;
  error_message: string | null;
};

export type NotificationRecipient =
  | { kind: 'user'; user_id: string; profile?: Record<string, string> }
  | { kind: 'list'; list_id: string }
  | { kind: 'audience'; audience_id: string };

export type NotificationTarget = {
  id: string;
  name: string;
  recipient: NotificationRecipient;
  workflow_id: string;
  routing: string[];
  version: number;
};

export type DeliveryState = 'pending' | 'submitting' | 'accepted' | 'delivered' | 'failed' | 'canceled' | 'unknown';

export type DeliveryIntent = {
  id: string;
  summary_revision: number;
  scenario_revision: number;
  target: NotificationTarget;
  payload: StudioScenarioNotificationV1;
  idempotency_key: string;
  state: DeliveryState;
  attempt: number;
  provider: 'courier';
  provider_request_id: string | null;
  provider_status: string | null;
  provider_history: Array<{ type: string; timestamp: string }>;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
};

export type TranscriptionJob = {
  id: string;
  event_id: string;
  recording_id: string;
  state: JobState;
  attempt: number;
  recording: RecordingSnapshot;
  processor_kind: string;
  processor_version: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  transcript: TranscriptV1 | null;
  transcript_revision: number;
  revisions: Revision<TranscriptV1>[];
  audio_path: string | null;
  playback_ready: boolean;
  summary_state: SummaryState;
  summary: MeetingSummaryV1 | null;
  summary_revision: number;
  summary_revisions: SummaryRevision[];
  summary_chunks: SummaryChunk[];
  summary_error_code: string | null;
  summary_error_message: string | null;
  artifacts: StudioArtifact[];
  scenario_id: string;
  scenario_state: 'waiting' | 'completed' | 'stale';
  scenario_result: ScenarioResultV1 | null;
  scenario_revision: number;
  scenario_revisions: ScenarioRevision[];
  scenario_confirmation: ScenarioConfirmation | null;
  action_intents: ActionIntent[];
  deliveries: DeliveryIntent[];
};

export type MeetingJob = {
  id: string;
  transcript_hash: string;
  upstream_revision: number;
  upstream_job_id: string | null;
  upstream_resource_version: number | null;
  recording_id: string;
  state: JobState;
  attempt: number;
  transcript: TranscriptV1;
  summary: MeetingSummaryV1 | null;
  summary_chunks: Array<{ index: number; input_hash: string; summary: MeetingSummaryV1 }>;
  revisions: Revision<MeetingSummaryV1>[];
  confirmed_at: string | null;
  confirmed_by: string | null;
  confirmation_note: string | null;
  supersedes_job_id: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  error_code: string | null;
  error_message: string | null;
};

export function validateTranscript(value: unknown): asserts value is TranscriptV1 {
  if (!value || typeof value !== 'object') throw new Error('TRANSCRIPT_INVALID');
  const item = value as Record<string, unknown>;
  if (item.schema_version !== 'demo.transcript.v1' || typeof item.recording_id !== 'string' || item.recording_id.length === 0 || item.recording_id.length > 256
    || !(item.language === null || typeof item.language === 'string') || (typeof item.language === 'string' && item.language.length > 64)
    || !(item.duration_ms === null || isNonNegativeInteger(item.duration_ms))
    || typeof item.text !== 'string' || item.text.length > 10_000_000 || !Array.isArray(item.segments) || item.segments.length > 100_000
    || !item.processor || typeof item.processor !== 'object') throw new Error('TRANSCRIPT_INVALID');
  const processor = item.processor as Record<string, unknown>;
  if (typeof processor.provider !== 'string' || !processor.provider || processor.provider.length > 128
    || typeof processor.model !== 'string' || !processor.model || processor.model.length > 256
    || !(processor.version === null || typeof processor.version === 'string') || (typeof processor.version === 'string' && processor.version.length > 256)) throw new Error('TRANSCRIPT_PROCESSOR_INVALID');
  let previousEnd = 0;
  const ids = new Set<string>();
  for (const raw of item.segments) {
    if (!raw || typeof raw !== 'object') throw new Error('TRANSCRIPT_SEGMENT_INVALID');
    const segment = raw as Record<string, unknown>;
    if (typeof segment.id !== 'string' || !segment.id || segment.id.length > 128 || ids.has(segment.id)
      || !isNonNegativeInteger(segment.start_ms) || !isNonNegativeInteger(segment.end_ms) || segment.end_ms < segment.start_ms || segment.start_ms < previousEnd
      || typeof segment.text !== 'string' || segment.text.length > 100_000
      || !(segment.speaker === null || typeof segment.speaker === 'string') || (typeof segment.speaker === 'string' && segment.speaker.length > 256)
      || !(segment.confidence === null || typeof segment.confidence === 'number' && Number.isFinite(segment.confidence) && segment.confidence >= 0 && segment.confidence <= 1)) throw new Error('TRANSCRIPT_SEGMENT_INVALID');
    ids.add(segment.id);
    previousEnd = segment.end_ms;
  }
  if (item.duration_ms !== null && previousEnd > item.duration_ms) throw new Error('TRANSCRIPT_DURATION_INVALID');
  const segmentText = (item.segments as TranscriptSegmentV1[]).map((segment) => segment.text);
  let textCursor = 0;
  for (const text of segmentText) {
    const index = item.text.indexOf(text, textCursor);
    if (index < 0) throw new Error('TRANSCRIPT_TEXT_MISMATCH');
    textCursor = index + text.length;
  }
}

export function validateMeetingSummary(summary: unknown, transcript: TranscriptV1): asserts summary is MeetingSummaryV1 {
  if (!summary || typeof summary !== 'object') throw new Error('SUMMARY_SCHEMA_INVALID');
  const item = summary as Record<string, unknown>;
  if (item.schema_version !== 'demo.meeting-summary.v1' || item.recording_id !== transcript.recording_id
    || typeof item.title !== 'string' || !item.title || item.title.length > 1_000
    || typeof item.overview !== 'string' || item.overview.length > 100_000
    || !Array.isArray(item.topics) || item.topics.length > 10_000 || !Array.isArray(item.decisions) || item.decisions.length > 10_000
    || !Array.isArray(item.action_items) || item.action_items.length > 10_000 || !item.model || typeof item.model !== 'object') throw new Error('SUMMARY_SCHEMA_INVALID');
  const model = item.model as Record<string, unknown>;
  if (typeof model.provider !== 'string' || !model.provider || model.provider.length > 128
    || typeof model.model !== 'string' || !model.model || model.model.length > 256
    || typeof model.prompt_version !== 'string' || !model.prompt_version || model.prompt_version.length > 256) throw new Error('SUMMARY_MODEL_INVALID');
  const validRefs = new Set(transcript.segments.map((segment) => segment.id));
  const assertRefs = (entries: unknown[], kind: string): void => {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw new Error('SUMMARY_SCHEMA_INVALID');
      const value = entry as Record<string, unknown>;
      const refs = value.segment_refs;
      if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== 'string' || !validRefs.has(ref))) throw new Error(`SUMMARY_REFERENCE_INVALID:${kind}`);
      if (kind === 'topic' && (typeof value.title !== 'string' || !value.title || value.title.length > 1_000 || typeof value.summary !== 'string' || value.summary.length > 100_000)) throw new Error('SUMMARY_SCHEMA_INVALID');
      if (kind === 'decision' && (typeof value.text !== 'string' || !value.text || value.text.length > 100_000)) throw new Error('SUMMARY_SCHEMA_INVALID');
      if (kind === 'action_item' && (typeof value.text !== 'string' || !value.text || value.text.length > 100_000
        || !(value.assignee === null || typeof value.assignee === 'string') || (typeof value.assignee === 'string' && value.assignee.length > 1_000)
        || !(value.due_at === null || typeof value.due_at === 'string' && !Number.isNaN(Date.parse(value.due_at))))) throw new Error('SUMMARY_SCHEMA_INVALID');
    }
  };
  assertRefs(item.topics, 'topic');
  assertRefs(item.decisions, 'decision');
  assertRefs(item.action_items, 'action_item');
}

export function transcriptContentHash(transcript: TranscriptV1): string {
  return createHash('sha256').update(JSON.stringify(transcript)).digest('hex');
}

export function validateScenarioResult(result: unknown, transcript: TranscriptV1, manifest: ScenarioManifest): asserts result is ScenarioResultV1 {
  if (!result || typeof result !== 'object') throw new Error('SCENARIO_RESULT_INVALID');
  const item = result as Record<string, unknown>;
  if (item.schema_version !== 'studio.scenario-result.v1' || item.scenario_id !== manifest.id || item.scenario_version !== manifest.version
    || item.recording_id !== transcript.recording_id || typeof item.title !== 'string' || !item.title || item.title.length > 1_000
    || typeof item.overview !== 'string' || item.overview.length > 100_000 || !item.values || typeof item.values !== 'object' || Array.isArray(item.values)
    || !Array.isArray(item.sections) || !Array.isArray(item.actions)
    || !Number.isSafeInteger(item.source_transcript_revision) || Number(item.source_transcript_revision) < 1
    || !Number.isSafeInteger(item.source_summary_revision) || Number(item.source_summary_revision) < 1) throw new Error('SCENARIO_RESULT_INVALID');
  const values = item.values as Record<string, unknown>;
  for (const field of manifest.fields) {
    if (field.required && !(field.key in values)) throw new Error(`SCENARIO_FIELD_REQUIRED:${field.key}`);
    const value = values[field.key];
    if (value === undefined || value === null) continue;
    if (field.type === 'string' && typeof value !== 'string' || field.type === 'number' && typeof value !== 'number'
      || field.type === 'boolean' && typeof value !== 'boolean'
      || field.type === 'string-list' && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) throw new Error(`SCENARIO_FIELD_INVALID:${field.key}`);
  }
  const validRefs = new Set(transcript.segments.map((segment) => segment.id));
  for (const raw of [...item.sections, ...item.actions]) {
    if (!raw || typeof raw !== 'object') throw new Error('SCENARIO_RESULT_INVALID');
  }
  for (const section of item.sections as ScenarioResultV1['sections']) {
    if (typeof section.id !== 'string' || typeof section.title !== 'string' || !Array.isArray(section.items)) throw new Error('SCENARIO_SECTION_INVALID');
    for (const entry of section.items) if (!entry.text || !Array.isArray(entry.segment_refs) || entry.segment_refs.some((ref) => !validRefs.has(ref))) throw new Error('SCENARIO_REFERENCE_INVALID');
  }
  for (const action of item.actions as ScenarioResultV1['actions']) {
    if (!action.id || !action.title || !action.description || !['low', 'medium', 'high'].includes(action.priority)
      || action.segment_refs.some((ref) => !validRefs.has(ref))) throw new Error('SCENARIO_ACTION_INVALID');
  }
}

export function validateTranscriptEnvelope(value: unknown): asserts value is TranscriptEnvelopeV1 {
  if (!value || typeof value !== 'object') throw new Error('TRANSCRIPT_ENVELOPE_INVALID');
  const item = value as Record<string, unknown>;
  if (item.schema_version !== 'demo.transcript-envelope.v1' || typeof item.recording_id !== 'string' || typeof item.source_job_id !== 'string'
    || !Number.isSafeInteger(item.source_recording_resource_version) || Number(item.source_recording_resource_version) < 1
    || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || typeof item.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.content_hash)
    || typeof item.created_at !== 'string' || Number.isNaN(Date.parse(item.created_at))) throw new Error('TRANSCRIPT_ENVELOPE_INVALID');
  validateTranscript(item.transcript);
  if ((item.transcript as TranscriptV1).recording_id !== item.recording_id || transcriptContentHash(item.transcript as TranscriptV1) !== item.content_hash) throw new Error('TRANSCRIPT_ENVELOPE_MISMATCH');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
