import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { DeviceEvent, RecordingFile } from '@voicecan/contracts';
import {
  SqliteStore, ensureParent, fileExists, mediaWithLc3Default, removeSensitiveFile, sanitizeError, storageDiagnostics,
  transcriptContentHash, transcriptToSrt, transcriptToText, validateMeetingSummary, validateScenarioResult, validateTranscript,
  type ActionIntent, type DeliveryIntent, type MeetingSummaryV1, type NotificationTarget, type RecordingSnapshot, type ScenarioResultV1,
  type StudioScenarioNotificationV1, type TranscriptV1,
  type TranscriptionJob, type TranscriptionProcessor,
} from './shared/index.js';
import type { AudioPipeline } from './audio-pipeline.js';
import { summaryInputKey, type SummaryProcessor } from './summary-processor.js';
import type { NotificationProvider } from './notification-provider.js';
import { createArtifact } from './kernel/artifact.js';
import { scenarioRegistry, type ScenarioBuildInput } from './scenarios/index.js';

export type RecordingClient = {
  get(recordingId: string): Promise<RecordingFile>;
  downloadToFile(recordingId: string, destination: string, options?: {
    signal?: AbortSignal;
    idempotencyKey?: string;
    onProgress?: (progress: { received: number; total: number }) => void;
  }): Promise<void>;
};

function snapshot(recording: RecordingFile, media = mediaWithLc3Default(recording.media)): RecordingSnapshot {
  return {
    id: recording.id, device_id: recording.device_id, attribute: recording.attribute, sha256: recording.sha256,
    media, timing: recording.timing,
    source_firmware_version: recording.source_firmware_version, resource_version: recording.resource_version,
  };
}

function normalizeJob(job: TranscriptionJob): TranscriptionJob {
  job.recording.sha256 ??= null;
  job.transcript_revision ??= job.transcript ? job.revisions.length + 1 : 0;
  job.summary_state ??= 'not_requested';
  job.summary ??= null;
  job.summary_revision ??= 0;
  job.summary_revisions ??= [];
  job.summary_chunks ??= [];
  job.summary_error_code ??= null;
  job.summary_error_message ??= null;
  if (job.summary_state === 'failed' && job.summary_error_code === 'TRANSCRIPT_EMPTY') {
    job.summary_state = 'skipped'; job.summary_error_code = null; job.summary_error_message = null;
  }
  job.artifacts ??= [];
  job.scenario_id ??= scenarioRegistry.defaultForAttribute(job.recording.attribute).manifest.id;
  job.scenario_state ??= job.summary ? 'stale' : 'waiting';
  job.scenario_result ??= null;
  job.scenario_revision ??= 0;
  job.scenario_revisions ??= [];
  job.scenario_confirmation ??= null;
  job.action_intents ??= [];
  job.deliveries ??= [];
  return job;
}

function hasSummaryInput(transcript: TranscriptV1): boolean {
  return transcript.segments.some((segment) => segment.text.trim().length > 0);
}

function applyScenario(job: TranscriptionJob, createdBy: string, kind: 'generated' | 'edited' = 'generated', provided?: ScenarioResultV1, note: string | null = null): void {
  if (job.action_intents.some((intent) => intent.state === 'executing')) throw Object.assign(new Error('ACTION_EXECUTION_IN_PROGRESS'), { status: 409 });
  if (!job.transcript || !job.summary || job.summary_state !== 'completed') throw Object.assign(new Error('SCENARIO_INPUT_NOT_READY'), { status: 409 });
  const definition = scenarioRegistry.required(job.scenario_id);
  const nextRevision = job.scenario_revision + 1;
  const input: ScenarioBuildInput = { recording: job.recording, transcript: job.transcript, transcriptRevision: job.transcript_revision, summary: job.summary, summaryRevision: job.summary_revision };
  const result = provided ?? scenarioRegistry.build(job.scenario_id, input);
  validateScenarioResult(result, job.transcript, definition.manifest);
  if (result.source_transcript_revision !== job.transcript_revision || result.source_summary_revision !== job.summary_revision) throw Object.assign(new Error('SCENARIO_SOURCE_REVISION_MISMATCH'), { status: 409 });
  job.scenario_revision = nextRevision;
  job.scenario_result = result;
  job.scenario_state = 'completed';
  job.scenario_confirmation = null;
  job.scenario_revisions.push({ revision: nextRevision, value: result, kind, created_at: new Date().toISOString(), created_by: createdBy.slice(0, 256), note: note?.slice(0, 1_000) ?? null });
  for (const intent of job.action_intents) if (intent.state === 'draft') { intent.state = 'canceled'; intent.updated_at = new Date().toISOString(); intent.error_code = 'SCENARIO_REVISION_CHANGED'; intent.error_message = 'The reviewed Scenario revision changed.'; }
  const parent = job.artifacts.filter((artifact) => artifact.kind === 'summary').at(-1);
  job.artifacts.push(createArtifact({ kind: 'scenario-result', schemaVersion: result.schema_version, revision: nextRevision, recording: job.recording, parents: parent ? [parent] : [], producer: { kind: `scenario:${job.scenario_id}`, version: definition.manifest.version }, payload: result }));
}

function chunkTranscript(transcript: TranscriptV1, maxSegments: number, maxCharacters: number): TranscriptV1[] {
  const chunks: TranscriptV1[] = [];
  let segments: TranscriptV1['segments'] = [];
  let characters = 0;
  const flush = (): void => {
    if (segments.length === 0) return;
    chunks.push({ ...transcript, duration_ms: segments.at(-1)?.end_ms ?? null, text: segments.map((item) => item.text).join(' '), segments });
    segments = [];
    characters = 0;
  };
  for (const segment of transcript.segments) {
    if (!segment.text.trim()) continue;
    if (segments.length > 0 && (segments.length >= maxSegments || characters + segment.text.length > maxCharacters)) flush();
    segments.push(segment);
    characters += segment.text.length;
  }
  flush();
  return chunks;
}

function mergeSummaries(transcript: TranscriptV1, chunks: MeetingSummaryV1[]): MeetingSummaryV1 {
  const first = chunks[0];
  if (!first) throw new Error('TRANSCRIPT_EMPTY');
  const merged: MeetingSummaryV1 = {
    schema_version: 'demo.meeting-summary.v1',
    recording_id: transcript.recording_id,
    title: first.title,
    overview: chunks.map((item) => item.overview).filter(Boolean).join('\n\n'),
    topics: chunks.flatMap((item) => item.topics),
    decisions: chunks.flatMap((item) => item.decisions),
    action_items: chunks.flatMap((item) => item.action_items),
    model: { ...first.model, prompt_version: chunks.length > 1 ? `${first.model.prompt_version}:chunked-v1` : first.model.prompt_version },
  };
  validateMeetingSummary(merged, transcript);
  return merged;
}

function scenarioNotificationPayload(job: TranscriptionJob, studioBaseUrl: string | null): StudioScenarioNotificationV1 {
  if (!job.scenario_result || !job.scenario_confirmation) throw Object.assign(new Error('SCENARIO_NOT_CONFIRMED'), { status: 409 });
  return {
    schema_version: 'studio.scenario-notification.v1', recording_id: job.recording_id, scenario_id: job.scenario_id,
    scenario_revision: job.scenario_revision, title: job.scenario_result.title, overview: job.scenario_result.overview,
    values: job.scenario_result.values,
    actions: job.scenario_result.actions.map(({ title, description, assignee, due_at, priority }) => ({ title, description, assignee, due_at, priority })),
    studio_url: studioBaseUrl ? `${studioBaseUrl.replace(/\/$/, '')}/?recording=${encodeURIComponent(job.recording_id)}` : null,
    confirmed_at: job.scenario_confirmation.confirmed_at, confirmed_by: job.scenario_confirmation.confirmed_by,
  };
}

function validateNotificationTarget(target: NotificationTarget): void {
  if (!target || typeof target !== 'object' || !target.id || target.id.length > 256 || !target.name || target.name.length > 256
    || !target.workflow_id || target.workflow_id.length > 256 || !Number.isSafeInteger(target.version) || target.version < 1
    || !Array.isArray(target.routing) || target.routing.some((item) => typeof item !== 'string' || !item || item.length > 128)) {
    throw Object.assign(new Error('NOTIFICATION_TARGET_INVALID'), { status: 422 });
  }
  const recipient = target.recipient;
  if (!recipient || typeof recipient !== 'object'
    || recipient.kind === 'user' && (!recipient.user_id || recipient.user_id.length > 256)
    || recipient.kind === 'list' && (!recipient.list_id || recipient.list_id.length > 256)
    || recipient.kind === 'audience' && (!recipient.audience_id || recipient.audience_id.length > 256)
    || !['user', 'list', 'audience'].includes(recipient.kind)) {
    throw Object.assign(new Error('NOTIFICATION_RECIPIENT_INVALID'), { status: 422 });
  }
}

function requiredDelivery(job: TranscriptionJob, deliveryId: string): DeliveryIntent {
  const delivery = job.deliveries.find((item) => item.id === deliveryId);
  if (!delivery) throw Object.assign(new Error('DELIVERY_NOT_FOUND'), { status: 404 });
  return delivery;
}

function requiredAction(job: TranscriptionJob, actionId: string): ActionIntent {
  const action = job.action_intents.find((item) => item.id === actionId);
  if (!action) throw Object.assign(new Error('ACTION_INTENT_NOT_FOUND'), { status: 404 });
  return action;
}

export class StudioService {
  readonly #store: SqliteStore<TranscriptionJob>;
  readonly #client: RecordingClient;
  readonly #processor: TranscriptionProcessor;
  readonly #audioPipeline: AudioPipeline | null;
  readonly #storageProbe: () => Promise<{ total_bytes: number; free_bytes: number; used_ratio: number }>;
  readonly #workDir: string;
  readonly #maxConcurrentJobs: number;
  readonly #summaryProcessor: SummaryProcessor | null;
  readonly #notificationProvider: NotificationProvider | null;
  readonly #studioBaseUrl: string | null;
  readonly #maxChunkSegments: number;
  readonly #maxChunkCharacters: number;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #summaryInFlight = new Map<string, Promise<void>>();
  readonly #deliveryInFlight = new Map<string, Promise<DeliveryIntent>>();
  readonly #processQueue: Array<{ id: string; resolve: () => void; reject: (error: unknown) => void }> = [];
  readonly #eventInFlight = new Map<string, { hash: string; task: Promise<TranscriptionJob | null> }>();
  readonly #downloadControllers = new Map<string, AbortController>();
  readonly #canceled = new Set<string>();
  #activeProcesses = 0;

  constructor(input: { databasePath: string; workDir: string; client: RecordingClient; processor: TranscriptionProcessor; summaryProcessor?: SummaryProcessor; notificationProvider?: NotificationProvider; studioBaseUrl?: string; audioPipeline?: AudioPipeline; storageProbe?: () => Promise<{ total_bytes: number; free_bytes: number; used_ratio: number }>; maxConcurrentJobs?: number; maxChunkSegments?: number; maxChunkCharacters?: number }) {
    this.#store = new SqliteStore(input.databasePath);
    this.#workDir = resolve(input.workDir);
    this.#client = input.client;
    this.#processor = input.processor;
    this.#audioPipeline = input.audioPipeline ?? null;
    this.#storageProbe = input.storageProbe ?? (() => storageDiagnostics(this.#workDir));
    this.#maxConcurrentJobs = input.maxConcurrentJobs ?? Number.POSITIVE_INFINITY;
    this.#summaryProcessor = input.summaryProcessor ?? null;
    this.#notificationProvider = input.notificationProvider ?? null;
    this.#studioBaseUrl = input.studioBaseUrl ?? null;
    this.#maxChunkSegments = input.maxChunkSegments ?? 200;
    this.#maxChunkCharacters = input.maxChunkCharacters ?? 60_000;
    if (this.#maxConcurrentJobs !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(this.#maxConcurrentJobs) || this.#maxConcurrentJobs < 1)) throw new Error('MAX_CONCURRENT_JOBS_INVALID');
    if (!Number.isSafeInteger(this.#maxChunkSegments) || this.#maxChunkSegments < 1 || !Number.isSafeInteger(this.#maxChunkCharacters) || this.#maxChunkCharacters < 1) throw new Error('SUMMARY_CHUNK_LIMIT_INVALID');
  }

  async list(): Promise<TranscriptionJob[]> { return (await this.#store.list()).map(normalizeJob); }
  async get(id: string): Promise<TranscriptionJob | undefined> { const job = await this.#store.get(id); return job ? normalizeJob(job) : undefined; }
  async drain(): Promise<void> { await Promise.allSettled([...this.#inFlight.values(), ...this.#summaryInFlight.values(), ...this.#deliveryInFlight.values()]); }
  async close(): Promise<void> { await this.drain(); await this.#store.close(); }
  queueDiagnostics(): { active: number; queued: number; concurrency_limit: number | null; policy: 'fifo' } {
    return { active: this.#activeProcesses, queued: this.#processQueue.length, concurrency_limit: Number.isFinite(this.#maxConcurrentJobs) ? this.#maxConcurrentJobs : null, policy: 'fifo' };
  }
  metrics(): Promise<Record<string, number>> { return this.#store.metrics(); }
  storage(): Promise<{ total_bytes: number; free_bytes: number; used_ratio: number }> { return this.#storageProbe(); }
  async quality(): Promise<Record<string, number | null>> {
    const jobs = await this.list(); const completed = jobs.filter((job) => job.state === 'completed');
    return {
      total_jobs: jobs.length, completed_jobs: completed.length, failed_jobs: jobs.filter((job) => job.state === 'failed').length,
      completion_rate: jobs.length ? completed.length / jobs.length : null,
      revised_transcript_rate: completed.length ? completed.filter((job) => job.revisions.length > 0).length / completed.length : null,
      average_attempts: jobs.length ? jobs.reduce((sum, job) => sum + job.attempt, 0) / jobs.length : null,
    };
  }
  async acceptEvent(event: DeviceEvent): Promise<TranscriptionJob | null> {
    const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const active = this.#eventInFlight.get(event.id);
    if (active) {
      if (active.hash !== hash) throw Object.assign(new Error('EVENT_ID_COLLISION'), { status: 409 });
      return active.task;
    }
    const task = this.#acceptEvent(event).finally(() => this.#eventInFlight.delete(event.id));
    this.#eventInFlight.set(event.id, { hash, task });
    return task;
  }

  async #acceptEvent(event: DeviceEvent): Promise<TranscriptionJob | null> {
    const recordingId = typeof event.data.file_id === 'string' ? event.data.file_id : undefined;
    if (!recordingId || !['file.synced', 'recording.deleted'].includes(event.type)) return null;
    const claim = await this.#store.claimEvent({ id: event.id, type: event.type, recordingId, payload: event });
    if (claim !== 'claimed') return null;
    try {
      if (event.type === 'recording.deleted') {
        await this.deleteByRecordingId(recordingId, 'recording_deleted', event.id);
        await this.#store.completeEvent(event.id);
        await this.#store.metric('events.recording_deleted');
        return null;
      }
      const recording = await this.#client.get(recordingId);
      const job = await this.acceptRecording(recording, event.id);
      await this.#store.completeEvent(event.id);
      await this.#store.metric('events.file_synced');
      return job;
    } catch (error) {
      await this.#store.failEvent(event.id, sanitizeError(error));
      await this.#store.metric('events.failed');
      throw error;
    }
  }

  async acceptRecording(recording: RecordingFile, sourceEventId: string): Promise<TranscriptionJob | null> {
    if (await this.#store.hasTombstone(recording.id)) return null;
    const job = await this.#store.update((items) => {
      const existing = items.map(normalizeJob).find((item) => item.event_id === sourceEventId || item.recording_id === recording.id);
      if (existing) {
        if (existing.recording_id !== recording.id) throw Object.assign(new Error('EVENT_ID_COLLISION'), { status: 409 });
        return existing;
      }
      const timestamp = new Date().toISOString();
      const media = mediaWithLc3Default(recording.media);
      const created: TranscriptionJob = {
        id: crypto.randomUUID(), event_id: sourceEventId, recording_id: recording.id,
        state: 'received', attempt: 0,
        recording: snapshot(recording, media), processor_kind: this.#processor.kind, processor_version: this.#processor.version,
        created_at: timestamp, updated_at: timestamp, started_at: null, completed_at: null,
        error_code: null,
        error_message: null,
        transcript: null, transcript_revision: 0, revisions: [], audio_path: null, playback_ready: false,
        summary_state: 'not_requested', summary: null, summary_revision: 0, summary_revisions: [], summary_chunks: [],
        summary_error_code: null, summary_error_message: null, deliveries: [],
        artifacts: [], scenario_id: scenarioRegistry.defaultForAttribute(recording.attribute).manifest.id, scenario_state: 'waiting',
        scenario_result: null, scenario_revision: 0, scenario_revisions: [], scenario_confirmation: null, action_intents: [],
      };
      items.push(created);
      return created;
    });
    await this.#store.metric('jobs.received');
    if (job.state === 'received') void this.process(job.id);
    return job;
  }

  process(id: string): Promise<void> {
    const active = this.#inFlight.get(id);
    if (active) return active;
    this.#canceled.delete(id);
    let resolveTask!: () => void;
    let rejectTask!: (error: unknown) => void;
    const task = new Promise<void>((resolvePromise, rejectPromise) => { resolveTask = resolvePromise; rejectTask = rejectPromise; });
    this.#inFlight.set(id, task);
    this.#processQueue.push({ id, resolve: resolveTask, reject: rejectTask });
    this.#dispatchQueuedJobs();
    return task;
  }

  #dispatchQueuedJobs(): void {
    while (this.#activeProcesses < this.#maxConcurrentJobs) {
      const next = this.#processQueue.shift();
      if (!next) return;
      this.#activeProcesses += 1;
      void this.#process(next.id).then(next.resolve, next.reject).finally(() => {
        this.#activeProcesses -= 1;
        this.#inFlight.delete(next.id);
        this.#dispatchQueuedJobs();
      });
    }
  }

  async recover(): Promise<number> {
    const recoverable = (await this.list()).filter((job) =>
      ['received', 'waiting_for_recording', 'downloading', 'validating', 'normalizing', 'processing', 'post_processing'].includes(job.state));
    for (const job of recoverable) {
      await rm(resolve(this.#workDir, job.id), { recursive: true, force: true });
      await this.#mutate(job.id, (current) => {
        current.state = 'received'; current.audio_path = null; current.playback_ready = false;
        current.error_code = 'RECOVERED_AFTER_RESTART'; current.error_message = 'The interrupted task was safely requeued after restart.';
      });
      void this.process(job.id);
    }
    const summaryRecoverable = (await this.list()).filter((job) => ['queued', 'processing'].includes(job.summary_state) && job.transcript);
    for (const job of summaryRecoverable) void this.generateSummary(job.id);
    const deliveryRecoverable = (await this.list()).flatMap((job) => job.deliveries.filter((delivery) => ['pending', 'submitting', 'unknown'].includes(delivery.state)).map((delivery) => ({ jobId: job.id, deliveryId: delivery.id })));
    for (const delivery of deliveryRecoverable) void this.#submitDelivery(delivery.jobId, delivery.deliveryId);
    if (recoverable.length > 0) await this.#store.metric('jobs.recovered', recoverable.length);
    return recoverable.length + summaryRecoverable.length + deliveryRecoverable.length;
  }

  async retry(id: string): Promise<void> {
    await this.#mutate(id, (job) => {
      if (!['failed', 'needs_attention', 'canceled'].includes(job.state)) throw Object.assign(new Error('JOB_NOT_RETRYABLE'), { status: 409 });
      job.state = 'received'; job.error_code = null; job.error_message = null; job.completed_at = null;
    });
    await this.#store.metric('jobs.retried');
    void this.process(id);
  }

  async cancel(id: string): Promise<void> {
    const job = await this.#required(id);
    this.#canceled.add(id);
    this.#downloadControllers.get(id)?.abort(new Error('JOB_CANCELED'));
    await this.#mutate(id, (current) => { current.state = 'canceled'; current.error_code = 'JOB_CANCELED'; current.error_message = 'Canceled by an operator.'; current.audio_path = null; current.playback_ready = false; });
    await removeSensitiveFile(job.audio_path);
    await rm(resolve(this.#workDir, id), { recursive: true, force: true });
    await this.#store.metric('jobs.canceled');
  }

  async revise(id: string, transcript: TranscriptV1, editor: string, note: string | null): Promise<TranscriptionJob> {
    validateTranscript(transcript);
    const existing = await this.#required(id);
    if (transcript.recording_id !== existing.recording_id) throw Object.assign(new Error('TRANSCRIPT_RECORDING_MISMATCH'), { status: 422 });
    const contentHash = transcriptContentHash(transcript);
    if (existing.transcript && transcriptContentHash(existing.transcript) === contentHash) return existing;
    if (existing.revisions.some((revision) => transcriptContentHash(revision.value) === contentHash)) {
      throw Object.assign(new Error('TRANSCRIPT_CONTENT_ALREADY_EXISTS'), { status: 409 });
    }
    const job = await this.#mutate(id, (current) => {
      if (transcript.recording_id !== current.recording_id) throw Object.assign(new Error('TRANSCRIPT_RECORDING_MISMATCH'), { status: 422 });
      if (current.action_intents.some((intent) => intent.state === 'executing')) throw Object.assign(new Error('ACTION_EXECUTION_IN_PROGRESS'), { status: 409 });
      if (current.transcript) current.revisions.push({ revision: current.transcript_revision, value: current.transcript, edited_at: new Date().toISOString(), edited_by: editor.slice(0, 256), note: note?.slice(0, 1_000) ?? null });
      current.transcript = transcript; current.transcript_revision += 1;
      if (!existing.transcript) {
        current.state = 'completed'; current.error_code = null; current.error_message = null;
        current.completed_at = new Date().toISOString();
      }
      if (!hasSummaryInput(transcript)) {
        current.summary = null; current.summary_state = 'skipped'; current.summary_error_code = null; current.summary_error_message = null;
        current.scenario_state = 'waiting'; current.scenario_result = null;
      } else {
        current.summary_state = current.summary ? 'stale' : 'not_requested'; current.scenario_state = 'stale';
      }
      current.scenario_confirmation = null;
      current.artifacts.push(createArtifact({ kind: 'transcript', schemaVersion: transcript.schema_version, revision: current.transcript_revision, recording: current.recording, producer: { kind: 'operator', version: editor.slice(0, 256) }, payload: transcript }));
      for (const intent of current.action_intents) if (intent.state === 'draft') { intent.state = 'canceled'; intent.error_code = 'TRANSCRIPT_STALE'; intent.error_message = 'The source Transcript changed.'; intent.updated_at = new Date().toISOString(); }
      for (const delivery of current.deliveries) {
        if (['pending', 'submitting', 'unknown'].includes(delivery.state)) {
          delivery.state = 'canceled'; delivery.completed_at = new Date().toISOString(); delivery.updated_at = delivery.completed_at;
          delivery.error_code = 'SUMMARY_STALE'; delivery.error_message = 'The source Transcript changed before provider acceptance.';
        }
      }
    });
    await this.#store.metric('transcripts.revised');
    return job;
  }

  async export(id: string, format: 'txt' | 'json' | 'srt'): Promise<{ contentType: string; body: string; filename: string }> {
    const job = await this.#required(id);
    if (!job.transcript) throw Object.assign(new Error('TRANSCRIPT_NOT_READY'), { status: 409 });
    if (format === 'txt') return { contentType: 'text/plain; charset=utf-8', body: transcriptToText(job.transcript), filename: `${job.recording_id}.txt` };
    if (format === 'srt') return { contentType: 'application/x-subrip; charset=utf-8', body: transcriptToSrt(job.transcript), filename: `${job.recording_id}.srt` };
    return { contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(job.transcript, null, 2)}\n`, filename: `${job.recording_id}.json` };
  }

  generateSummary(id: string): Promise<void> {
    const active = this.#summaryInFlight.get(id);
    if (active) return active;
    const task = this.#generateSummary(id).finally(() => this.#summaryInFlight.delete(id));
    this.#summaryInFlight.set(id, task);
    return task;
  }

  async reviseSummary(id: string, summary: MeetingSummaryV1, editor: string, note: string | null): Promise<TranscriptionJob> {
    const result = await this.#mutate(id, (job) => {
      if (!job.transcript || !job.summary || job.summary_state === 'stale') throw Object.assign(new Error('SUMMARY_NOT_EDITABLE'), { status: 409 });
      validateMeetingSummary(summary, job.transcript);
      const sourceHash = transcriptContentHash(job.transcript);
      const timestamp = new Date().toISOString();
      job.summary_revision += 1;
      job.summary = summary;
      job.summary_state = 'completed';
      job.summary_revisions.push({
        revision: job.summary_revision, source_transcript_revision: job.transcript_revision, source_transcript_hash: sourceHash,
        input_key: createHash('sha256').update(`${sourceHash}:manual:${job.summary_revision}`).digest('hex'), value: summary,
        kind: 'edited', created_at: timestamp, created_by: editor.slice(0, 256), note: note?.slice(0, 1_000) ?? null,
      });
      const parent = job.artifacts.filter((artifact) => artifact.kind === 'transcript').at(-1);
      job.artifacts.push(createArtifact({ kind: 'summary', schemaVersion: summary.schema_version, revision: job.summary_revision, recording: job.recording, parents: parent ? [parent] : [], producer: { kind: 'operator', version: editor.slice(0, 256) }, payload: summary }));
      applyScenario(job, editor, 'generated');
    });
    await this.#store.metric('summaries.revised');
    return result;
  }

  async summaryMarkdown(id: string): Promise<string> {
    const job = await this.#required(id);
    const summary = job.summary;
    if (!job.transcript || !summary) throw Object.assign(new Error('SUMMARY_NOT_READY'), { status: 409 });
    const segments = new Map(job.transcript.segments.map((item) => [item.id, item]));
    const refs = (ids: string[]): string => ids.map((ref) => {
      const item = segments.get(ref);
      return item ? `[${ref} · ${Math.floor(item.start_ms / 1000)}s–${Math.ceil(item.end_ms / 1000)}s]` : `[${ref}]`;
    }).join(', ');
    return `# ${summary.title}\n\n${summary.overview}\n\n## 议题\n\n${summary.topics.map((topic) => `### ${topic.title}\n\n${topic.summary}\n\n来源：${refs(topic.segment_refs)}`).join('\n\n')}\n\n## 决策\n\n${summary.decisions.map((item) => `- ${item.text} — ${refs(item.segment_refs)}`).join('\n')}\n\n## 行动项\n\n${summary.action_items.map((item) => `- [ ] ${item.text}（负责人：${item.assignee ?? '待确认'}；截止：${item.due_at ?? '待确认'}）— ${refs(item.segment_refs)}`).join('\n')}\n\n---\n\nProcessor Artifact · Summary revision ${job.summary_revision} · Transcript revision ${job.transcript_revision}\n`;
  }

  scenarios() { return scenarioRegistry.list(); }

  async selectScenario(id: string, scenarioId: string): Promise<TranscriptionJob> {
    scenarioRegistry.required(scenarioId);
    const result = await this.#mutate(id, (job) => {
      job.scenario_id = scenarioId; job.scenario_confirmation = null;
      if (job.transcript && job.summary && job.summary_state === 'completed') applyScenario(job, 'scenario-selection');
      else { job.scenario_state = 'waiting'; job.scenario_result = null; }
    });
    await this.#store.metric('scenarios.selected');
    return result;
  }

  async reviseScenario(id: string, result: ScenarioResultV1, editor: string, note: string | null): Promise<TranscriptionJob> {
    const updated = await this.#mutate(id, (job) => applyScenario(job, editor, 'edited', result, note));
    await this.#store.metric('scenarios.revised');
    return updated;
  }

  async confirmScenario(id: string, actor = 'api', note: string | null = null): Promise<TranscriptionJob> {
    const updated = await this.#mutate(id, (job) => {
      if (!job.scenario_result || job.scenario_state !== 'completed') throw Object.assign(new Error('SCENARIO_NOT_CONFIRMABLE'), { status: 409 });
      job.scenario_confirmation = { scenario_revision: job.scenario_revision, confirmed_at: new Date().toISOString(), confirmed_by: actor.slice(0, 256), note: note?.slice(0, 1_000) ?? null };
    });
    await this.#store.metric('scenarios.confirmed');
    return updated;
  }

  async unconfirmScenario(id: string): Promise<TranscriptionJob> {
    const updated = await this.#mutate(id, (job) => {
      if (!job.scenario_confirmation) throw Object.assign(new Error('SCENARIO_NOT_CONFIRMED'), { status: 409 });
      if (job.action_intents.some((action) => ['executing', 'submitted', 'completed'].includes(action.state))) throw Object.assign(new Error('ACTION_ALREADY_EXECUTED'), { status: 409 });
      job.scenario_confirmation = null;
      for (const action of job.action_intents) if (action.state === 'draft') { action.state = 'canceled'; action.updated_at = new Date().toISOString(); }
    });
    await this.#store.metric('scenarios.unconfirmed');
    return updated;
  }

  async scenarioMarkdown(id: string): Promise<string> {
    const job = await this.#required(id); const result = job.scenario_result;
    if (!result) throw Object.assign(new Error('SCENARIO_NOT_READY'), { status: 409 });
    const fields = Object.entries(result.values).map(([key, value]) => `- **${key}**: ${Array.isArray(value) ? value.join(', ') : String(value)}`).join('\n');
    const sections = result.sections.map((section) => `## ${section.title}\n\n${section.items.map((item) => `- ${item.text} — ${item.segment_refs.join(', ')}`).join('\n')}`).join('\n\n');
    const actions = result.actions.map((action) => `- [ ] ${action.title}（${action.assignee ?? '待确认'}；${action.due_at ?? '无截止时间'}；${action.priority}）`).join('\n');
    return `# ${result.title}\n\n${result.overview}\n\n## 场景字段\n\n${fields}\n\n${sections}\n\n## 后续动作\n\n${actions}\n\n---\n\nScenario ${result.scenario_id}@${result.scenario_version} · revision ${job.scenario_revision}\n审核：${job.scenario_confirmation ? `${job.scenario_confirmation.confirmed_by} · ${job.scenario_confirmation.confirmed_at}` : '待审核'}\n`;
  }

  async createActionIntent(id: string, target: NotificationTarget): Promise<ActionIntent> {
    validateNotificationTarget(target);
    const job = await this.#required(id);
    if (!scenarioRegistry.required(job.scenario_id).manifest.allowed_actions.includes('courier.notify')) throw Object.assign(new Error('SCENARIO_ACTION_NOT_ALLOWED'), { status: 409 });
    const preview = scenarioNotificationPayload(job, this.#studioBaseUrl);
    const idempotencyKey = createHash('sha256').update(`${job.id}:${job.scenario_id}:${job.scenario_revision}:${job.scenario_confirmation!.confirmed_at}:${target.id}:${target.version}`).digest('hex');
    const existing = job.action_intents.find((action) => action.idempotency_key === idempotencyKey);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const action: ActionIntent = { id: crypto.randomUUID(), kind: 'courier.notify', scenario_id: job.scenario_id, scenario_revision: job.scenario_revision, target, preview, idempotency_key: idempotencyKey, state: 'draft', delivery_id: null, created_at: timestamp, updated_at: timestamp, error_code: null, error_message: null };
    await this.#mutate(id, (current) => { current.action_intents.push(action); });
    await this.#store.metric('actions.created');
    return action;
  }

  async executeActionIntent(id: string, actionId: string): Promise<ActionIntent> {
    if (!this.#notificationProvider) throw Object.assign(new Error('NOTIFICATION_PROVIDER_DISABLED'), { status: 503 });
    const job = await this.#required(id); const action = requiredAction(job, actionId);
    if (action.state === 'completed') return action;
    if (action.state !== 'draft' || !job.scenario_confirmation || job.scenario_confirmation.scenario_revision !== action.scenario_revision || job.scenario_revision !== action.scenario_revision) throw Object.assign(new Error('ACTION_NOT_EXECUTABLE'), { status: 409 });
    const timestamp = new Date().toISOString();
    const delivery: DeliveryIntent = { id: crypto.randomUUID(), summary_revision: job.summary_revision, scenario_revision: action.scenario_revision, target: action.target, payload: action.preview, idempotency_key: action.idempotency_key, state: 'pending', attempt: 0, provider: 'courier', provider_request_id: null, provider_status: null, provider_history: [], created_at: timestamp, updated_at: timestamp, accepted_at: null, completed_at: null, error_code: null, error_message: null };
    await this.#mutate(id, (current) => { const mutable = requiredAction(current, actionId); mutable.state = 'executing'; mutable.delivery_id = delivery.id; mutable.updated_at = timestamp; current.deliveries.push(delivery); });
    const submitted = await this.#submitDelivery(id, delivery.id);
    const updated = await this.#mutate(id, (current) => { const mutable = requiredAction(current, actionId); mutable.state = submitted.state === 'delivered' ? 'completed' : submitted.state === 'accepted' ? 'submitted' : 'failed'; mutable.error_code = submitted.error_code; mutable.error_message = submitted.error_message; mutable.updated_at = new Date().toISOString(); });
    await this.#store.metric('actions.executed');
    return requiredAction(updated, actionId);
  }

  async refreshDelivery(id: string, deliveryId: string): Promise<DeliveryIntent> {
    const provider = this.#notificationProvider;
    if (!provider) throw Object.assign(new Error('NOTIFICATION_PROVIDER_DISABLED'), { status: 503 });
    const job = await this.#required(id);
    const delivery = job.deliveries.find((item) => item.id === deliveryId);
    if (!delivery) throw Object.assign(new Error('DELIVERY_NOT_FOUND'), { status: 404 });
    if (!delivery.provider_request_id) return this.#submitDelivery(id, deliveryId);
    const [status, history] = await Promise.all([provider.getStatus(delivery.provider_request_id), provider.getHistory(delivery.provider_request_id)]);
    const updated = await this.#mutate(id, (current) => {
      const item = requiredDelivery(current, deliveryId);
      item.provider_status = status.status; item.provider_history = history; item.updated_at = new Date().toISOString();
      if (status.terminal) { item.state = status.successful ? 'delivered' : 'failed'; item.completed_at = item.updated_at; }
      else item.state = 'accepted';
      const action = current.action_intents.find((candidate) => candidate.delivery_id === deliveryId);
      if (action) { action.state = item.state === 'delivered' ? 'completed' : item.state === 'failed' ? 'failed' : 'submitted'; action.updated_at = item.updated_at; action.error_code = item.error_code; action.error_message = item.error_message; }
    });
    return requiredDelivery(updated, deliveryId);
  }

  async cancelDelivery(id: string, deliveryId: string): Promise<DeliveryIntent> {
    const provider = this.#notificationProvider;
    if (!provider) throw Object.assign(new Error('NOTIFICATION_PROVIDER_DISABLED'), { status: 503 });
    const job = await this.#required(id);
    const delivery = requiredDelivery(job, deliveryId);
    if (!delivery.provider_request_id) {
      const updated = await this.#mutate(id, (current) => {
        const item = requiredDelivery(current, deliveryId); item.state = 'canceled'; item.completed_at = new Date().toISOString(); item.updated_at = item.completed_at;
        const action = current.action_intents.find((candidate) => candidate.delivery_id === deliveryId);
        if (action) { action.state = 'canceled'; action.updated_at = item.updated_at; }
      });
      return requiredDelivery(updated, deliveryId);
    }
    const status = await provider.cancel(delivery.provider_request_id);
    const updated = await this.#mutate(id, (current) => {
      const item = requiredDelivery(current, deliveryId); item.state = 'canceled'; item.provider_status = status.status;
      item.completed_at = new Date().toISOString(); item.updated_at = item.completed_at;
      const action = current.action_intents.find((candidate) => candidate.delivery_id === deliveryId);
      if (action) { action.state = 'canceled'; action.updated_at = item.updated_at; }
    });
    return requiredDelivery(updated, deliveryId);
  }

  providerHealth(): Promise<{ ok: boolean; detail: string }> {
    return this.#notificationProvider?.health() ?? Promise.resolve({ ok: false, detail: 'Notification egress is disabled.' });
  }

  async playback(id: string): Promise<{ path: string; contentType: string; filename: string }> {
    const job = await this.#required(id);
    const path = resolve(this.#workDir, id, 'playback.m4a');
    if (!job.playback_ready || !(await fileExists(path))) throw Object.assign(new Error('PLAYBACK_NOT_READY'), { status: 404 });
    const stem = job.recording_id.replace(/[^a-zA-Z0-9._-]/g, '_') || 'recording';
    return { path, contentType: 'audio/mp4', filename: `${stem}.m4a` };
  }

  async delete(id: string, reason = 'operator_deleted'): Promise<void> {
    const job = await this.#required(id);
    await this.#deleteJob(job);
    await this.#store.addTombstone(job.recording_id, reason);
  }

  async deleteByRecordingId(recordingId: string, reason = 'recording_deleted', eventId?: string): Promise<void> {
    await this.#store.addTombstone(recordingId, reason, eventId);
    const matches = (await this.list()).filter((job) => job.recording_id === recordingId);
    for (const job of matches) await this.#deleteJob(job);
  }

  async reconcileAuthorized(recordingIds: ReadonlySet<string>): Promise<number> {
    const unauthorized = (await this.list()).filter((job) => !recordingIds.has(job.recording_id));
    for (const job of unauthorized) await this.delete(job.id, 'authorization_lost');
    if (unauthorized.length > 0) await this.#store.metric('jobs.authorization_lost', unauthorized.length);
    return unauthorized.length;
  }

  async prune(retentionDays: number): Promise<number> {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) return 0;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const expired = (await this.list()).filter((job) => ['completed', 'failed', 'canceled'].includes(job.state) && Date.parse(job.completed_at ?? job.updated_at) < cutoff);
    for (const job of expired) await this.delete(job.id, 'retention_expired');
    if (expired.length > 0) await this.#store.metric('jobs.retention_expired', expired.length);
    return expired.length;
  }

  async #generateSummary(id: string): Promise<void> {
    try {
      const job = await this.#required(id);
      if (!job.transcript || job.state !== 'completed') throw Object.assign(new Error('TRANSCRIPT_NOT_READY'), { status: 409 });
      if (!hasSummaryInput(job.transcript)) {
        await this.#mutate(id, (current) => {
          current.summary = null; current.summary_state = 'skipped'; current.summary_error_code = null; current.summary_error_message = null;
          current.scenario_state = 'waiting'; current.scenario_result = null; current.scenario_confirmation = null;
        });
        await this.#store.metric('summaries.skipped');
        return;
      }
      const processor = this.#summaryProcessor;
      if (!processor) throw Object.assign(new Error('SUMMARY_PROCESSOR_DISABLED'), { status: 503 });
      if (!(await processor.ready())) {
        await this.#failSummary(id, 'SUMMARIZER_UNAVAILABLE', 'Summary Processor is unavailable; the Transcript remains intact.');
        return;
      }
      const sourceRevision = job.transcript_revision;
      const sourceHash = transcriptContentHash(job.transcript);
      const inputKey = summaryInputKey(job.transcript, processor);
      const existing = job.summary_revisions.find((item) => item.input_key === inputKey && item.source_transcript_revision === sourceRevision);
      if (existing) {
        await this.#mutate(id, (current) => {
          current.summary = existing.value; current.summary_revision = existing.revision; current.summary_state = 'completed';
          current.summary_error_code = null; current.summary_error_message = null;
          if (!current.scenario_result || current.scenario_state !== 'completed' || current.scenario_result.source_summary_revision !== current.summary_revision) applyScenario(current, 'summary-cache');
        });
        return;
      }
      await this.#mutate(id, (current) => {
        current.summary_state = 'processing'; current.summary_error_code = null; current.summary_error_message = null;
      });
      const chunks = chunkTranscript(job.transcript, this.#maxChunkSegments, this.#maxChunkCharacters);
      if (chunks.length === 0) throw new Error('SUMMARY_INPUT_EMPTY');
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const chunkHash = summaryInputKey(chunk, processor);
        const current = await this.#required(id);
        if (current.summary_chunks.some((item) => item.source_transcript_revision === sourceRevision && item.index === index && item.input_hash === chunkHash)) continue;
        const summary = await processor.summarize(chunk);
        validateMeetingSummary(summary, chunk);
        await this.#mutate(id, (item) => {
          item.summary_chunks = item.summary_chunks.filter((entry) => !(entry.source_transcript_revision === sourceRevision && entry.index === index));
          item.summary_chunks.push({ source_transcript_revision: sourceRevision, index, input_hash: chunkHash, summary });
        });
      }
      const completed = await this.#required(id);
      if (!completed.transcript || completed.transcript_revision !== sourceRevision || transcriptContentHash(completed.transcript) !== sourceHash) {
        await this.#failSummary(id, 'SUMMARY_INPUT_STALE', 'Transcript changed while Summary generation was running.');
        return;
      }
      const summary = mergeSummaries(completed.transcript, completed.summary_chunks
        .filter((item) => item.source_transcript_revision === sourceRevision)
        .sort((left, right) => left.index - right.index)
        .map((item) => item.summary));
      await this.#mutate(id, (current) => {
        const timestamp = new Date().toISOString();
        current.summary_revision += 1;
        current.summary = summary;
        current.summary_state = 'completed';
        current.summary_error_code = null;
        current.summary_error_message = null;
        current.summary_revisions.push({
          revision: current.summary_revision, source_transcript_revision: sourceRevision, source_transcript_hash: sourceHash,
          input_key: inputKey, value: summary, kind: 'generated', created_at: timestamp, created_by: processor.kind, note: null,
        });
        const parent = current.artifacts.filter((artifact) => artifact.kind === 'transcript').at(-1);
        current.artifacts.push(createArtifact({ kind: 'summary', schemaVersion: summary.schema_version, revision: current.summary_revision, recording: current.recording, parents: parent ? [parent] : [], producer: { kind: processor.kind, version: processor.version }, payload: summary }));
        applyScenario(current, processor.kind);
      });
      await this.#store.metric('summaries.completed');
    } catch (error) {
      try { await this.#failSummary(id, error instanceof Error ? error.message.split(':')[0] ?? 'SUMMARY_FAILED' : 'SUMMARY_FAILED', sanitizeError(error)); }
      catch (failureError) { if (!(failureError instanceof Error) || failureError.message !== 'JOB_NOT_FOUND') throw failureError; }
    }
  }

  #submitDelivery(id: string, deliveryId: string): Promise<DeliveryIntent> {
    const active = this.#deliveryInFlight.get(deliveryId);
    if (active) return active;
    const task = this.#runDeliverySubmit(id, deliveryId).finally(() => this.#deliveryInFlight.delete(deliveryId));
    this.#deliveryInFlight.set(deliveryId, task);
    return task;
  }

  async #runDeliverySubmit(id: string, deliveryId: string): Promise<DeliveryIntent> {
    const provider = this.#notificationProvider;
    if (!provider) throw Object.assign(new Error('NOTIFICATION_PROVIDER_DISABLED'), { status: 503 });
    const job = await this.#required(id);
    const delivery = requiredDelivery(job, deliveryId);
    if (['accepted', 'delivered', 'canceled'].includes(delivery.state)) return delivery;
    const currentSource = Boolean(job.scenario_confirmation && job.scenario_confirmation.scenario_revision === delivery.scenario_revision && job.scenario_revision === delivery.scenario_revision && job.scenario_state === 'completed');
    if (!currentSource) {
      const canceled = await this.#mutate(id, (current) => {
        const item = requiredDelivery(current, deliveryId); item.state = 'canceled'; item.error_code = 'REVIEW_NOT_CURRENT';
        item.error_message = 'Only the current confirmed revision can be submitted.'; item.completed_at = new Date().toISOString(); item.updated_at = item.completed_at;
      });
      return requiredDelivery(canceled, deliveryId);
    }
    await this.#mutate(id, (current) => {
      const item = requiredDelivery(current, deliveryId); item.state = 'submitting'; item.attempt += 1; item.updated_at = new Date().toISOString();
    });
    try {
      const result = await provider.submit({ target: delivery.target, payload: delivery.payload, idempotencyKey: delivery.idempotency_key });
      const accepted = await this.#mutate(id, (current) => {
        const item = requiredDelivery(current, deliveryId); item.state = 'accepted'; item.provider_request_id = result.requestId;
        item.provider_status = 'ENQUEUED'; item.accepted_at = new Date().toISOString(); item.updated_at = item.accepted_at;
        item.error_code = null; item.error_message = null;
      });
      await this.#store.metric('deliveries.accepted');
      return requiredDelivery(accepted, deliveryId);
    } catch (error) {
      const retryable = error instanceof Error && 'retryable' in error && error.retryable === true;
      const failed = await this.#mutate(id, (current) => {
        const item = requiredDelivery(current, deliveryId); item.state = retryable ? 'unknown' : 'failed';
        item.error_code = error instanceof Error ? error.message.split(':')[0] ?? 'COURIER_SUBMIT_FAILED' : 'COURIER_SUBMIT_FAILED';
        item.error_message = sanitizeError(error); item.updated_at = new Date().toISOString(); if (!retryable) item.completed_at = item.updated_at;
      });
      await this.#store.metric(retryable ? 'deliveries.retryable_failed' : 'deliveries.failed');
      return requiredDelivery(failed, deliveryId);
    }
  }

  async #process(id: string): Promise<void> {
    let audioPath: string | null = null;
    let normalizedPath: string | null = null;
    let decodedPath: string | null = null;
    let playbackPath: string | null = null;
    const started = Date.now();
    try {
      const initial = await this.#required(id);
      if (!['received', 'failed'].includes(initial.state)) return;
      if (!(await this.#processor.ready())) {
        await this.#fail(id, 'PROCESSOR_UNAVAILABLE', 'Processor is not ready; no download grant was created.');
        return;
      }
      const storage = await this.storage();
      if (storage.used_ratio >= 0.9) { await this.#fail(id, 'STORAGE_PRESSURE', 'Work storage is above the 90% safety watermark; no download grant was created.'); return; }
      const current = await this.#client.get(initial.recording_id);
      const media = mediaWithLc3Default(current.media);
      if (this.#audioPipeline) await this.#audioPipeline.assertReady(media);
      this.#throwIfCanceled(id);
      const extension = media.filename_extension.replace(/[^a-z0-9]/gi, '');
      const workspace = resolve(this.#workDir, id);
      audioPath = resolve(workspace, `recording.${extension || 'audio'}`);
      if (this.#audioPipeline) {
        normalizedPath = resolve(workspace, 'normalized.wav'); decodedPath = resolve(workspace, 'decoded.wav'); playbackPath = resolve(workspace, 'playback.m4a');
      }
      await ensureParent(audioPath);
      await this.#mutate(id, (job) => { job.state = 'downloading'; job.attempt += 1; job.started_at ??= new Date().toISOString(); job.audio_path = audioPath; job.recording = snapshot(current, media); });
      const downloadStarted = Date.now();
      if (!(await fileExists(audioPath))) {
        let downloadedBytes = 0;
        const controller = new AbortController();
        this.#downloadControllers.set(id, controller);
        await this.#client.downloadToFile(current.id, audioPath, {
          signal: controller.signal,
          idempotencyKey: `studio-download:${id}:${initial.attempt + 1}`,
          onProgress: ({ received }) => { downloadedBytes = received; },
        });
        if (downloadedBytes > 0) await this.#store.metric('download.bytes', downloadedBytes);
      }
      await this.#store.metric('duration.download_ms', Date.now() - downloadStarted);
      this.#throwIfCanceled(id);
      await this.#mutate(id, (job) => { job.state = 'validating'; });
      if (this.#audioPipeline) await this.#mutate(id, (job) => { job.state = 'normalizing'; });
      const normalizeStarted = Date.now();
      const prepared = this.#audioPipeline
        ? await this.#audioPipeline.prepare({ sourcePath: audioPath, workspace, media })
        : { transcriptionPath: audioPath, playbackPath: null, transcriptionMedia: media };
      await this.#store.metric('duration.normalize_ms', Date.now() - normalizeStarted);
      this.#throwIfCanceled(id);
      await this.#mutate(id, (job) => { job.state = 'processing'; });
      const processorStarted = Date.now();
      const transcript = await this.#processor.transcribe({ audio_path: prepared.transcriptionPath, recording_id: current.id, media: prepared.transcriptionMedia });
      validateTranscript(transcript);
      if (transcript.recording_id !== current.id) throw new Error('TRANSCRIPT_RECORDING_MISMATCH');
      await this.#store.metric('duration.processor_ms', Date.now() - processorStarted);
      this.#throwIfCanceled(id);
      const cleanup = await Promise.allSettled([removeSensitiveFile(audioPath), removeSensitiveFile(normalizedPath), removeSensitiveFile(decodedPath)]);
      if (cleanup.some((result) => result.status === 'rejected')) throw new Error('AUDIO_CLEANUP_FAILED');
      await this.#mutate(id, (job) => {
        job.state = 'post_processing'; job.transcript = transcript; job.transcript_revision = Math.max(1, job.transcript_revision + 1);
        job.artifacts.push(createArtifact({ kind: 'transcript', schemaVersion: transcript.schema_version, revision: job.transcript_revision, recording: job.recording, producer: { kind: this.#processor.kind, version: this.#processor.version }, payload: transcript }));
        job.state = 'completed'; job.completed_at = new Date().toISOString(); job.error_code = null; job.error_message = null; job.audio_path = null; job.playback_ready = prepared.playbackPath !== null;
      });
      await this.#store.metric('jobs.completed');
      await this.#store.metric('duration.total_ms', Date.now() - started);
      if (this.#summaryProcessor) await this.generateSummary(id);
    } catch (error) {
      const cleanup = await Promise.allSettled([removeSensitiveFile(audioPath), removeSensitiveFile(normalizedPath), removeSensitiveFile(decodedPath), removeSensitiveFile(playbackPath)]);
      const cleanupFailed = cleanup.some((result) => result.status === 'rejected');
      if (this.#canceled.has(id)) return;
      try {
        await this.#fail(id, cleanupFailed ? 'AUDIO_CLEANUP_FAILED' : error instanceof Error ? error.message.split(':')[0] ?? 'PROCESSING_FAILED' : 'PROCESSING_FAILED', cleanupFailed ? 'Sensitive audio cleanup failed; operator action is required.' : sanitizeError(error));
      } catch (failureError) {
        if (!(failureError instanceof Error) || failureError.message !== 'JOB_NOT_FOUND') throw failureError;
      }
    } finally {
      this.#downloadControllers.delete(id);
    }
  }

  async #deleteJob(job: TranscriptionJob): Promise<void> {
    this.#canceled.add(job.id);
    this.#downloadControllers.get(job.id)?.abort(new Error('JOB_DELETED'));
    await this.#store.update((items) => { const index = items.findIndex((item) => item.id === job.id); if (index >= 0) items.splice(index, 1); });
    await removeSensitiveFile(job.audio_path);
    await rm(resolve(this.#workDir, job.id), { recursive: true, force: true });
    await this.#store.metric('jobs.deleted');
  }

  async #fail(id: string, code: string, message: string): Promise<void> {
    await this.#mutate(id, (job) => { job.state = 'failed'; job.error_code = code; job.error_message = message; job.audio_path = null; job.playback_ready = false; });
    await this.#store.metric('jobs.failed');
  }

  async #failSummary(id: string, code: string, message: string): Promise<void> {
    await this.#mutate(id, (job) => { job.summary_state = 'failed'; job.summary_error_code = code; job.summary_error_message = message; });
    await this.#store.metric('summaries.failed');
  }

  #throwIfCanceled(id: string): void { if (this.#canceled.has(id)) throw new Error('JOB_CANCELED'); }

  async #required(id: string): Promise<TranscriptionJob> {
    const job = await this.#store.get(id);
    if (!job) throw Object.assign(new Error('JOB_NOT_FOUND'), { status: 404 });
    return normalizeJob(job);
  }

  async #mutate(id: string, change: (job: TranscriptionJob) => void): Promise<TranscriptionJob> {
    return this.#store.update((items) => {
      const job = items.find((item) => item.id === id);
      if (!job) throw Object.assign(new Error('JOB_NOT_FOUND'), { status: 404 });
      normalizeJob(job); change(job); job.updated_at = new Date().toISOString();
      return job;
    });
  }
}
