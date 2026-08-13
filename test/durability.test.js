import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../studio/dist/shared/index.js';
import { StudioService } from '../studio/dist/service.js';

class TestTranscriptionProcessor {
  kind = 'test';
  version = 'test-v1';
  async ready() { return true; }
  async transcribe(input) {
    const duration = input.media.duration_ms ?? 1000;
    const segments = [{ id: 'seg-0001', start_ms: 0, end_ms: duration, text: 'durable transcript', speaker: null, confidence: 1 }];
    return {
      schema_version: 'demo.transcript.v1', recording_id: input.recording_id, language: 'en', duration_ms: duration,
      text: 'durable transcript', segments, processor: { provider: 'test', model: 'durability', version: this.version },
    };
  }
}

function recording(id = 'recording-durable') {
  const now = '2026-08-11T00:00:00.000Z';
  return { id, device_id: 'device-1', session_id: 1, attribute: 7, revision: 1, expected_size: 5, actual_size: 5, sha256: null, status: 'synced', transport: 'fixture', error_code: null, media: { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 5000, encoding_profile: 'fixture-wav', source: 'server_verified' }, timing: { device_started_at: now, device_ended_at: now, duration_ms: 5000, device_timezone_offset_minutes: 480, discovered_at: now, synced_at: now }, source_firmware_version: 'fixture', resource_version: 3, created_at: now, updated_at: now, synced_at: now, legal_hold: false, legal_hold_reason: null, deletion_status: 'active', deletion_requested_at: null, object_deleted_at: null };
}

test('SQLite store detects event collisions and preserves tombstones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-store-')); const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  assert.equal(await store.claimEvent({ id: 'event-1', type: 'file.synced', recordingId: 'rec-1', payload: { value: 1 } }), 'claimed');
  await store.completeEvent('event-1');
  assert.equal(await store.claimEvent({ id: 'event-1', type: 'file.synced', recordingId: 'rec-1', payload: { value: 1 } }), 'duplicate');
  await assert.rejects(store.claimEvent({ id: 'event-1', type: 'file.synced', recordingId: 'rec-1', payload: { value: 2 } }), /EVENT_ID_COLLISION/);
  await store.addTombstone('rec-deleted', 'recording_deleted');
  assert.equal(await store.claimEvent({ id: 'event-2', type: 'file.synced', recordingId: 'rec-deleted', payload: {} }), 'tombstoned');
  await store.close();
});

test('transcription authorization reconciliation deletes results and tombstones prevent recreation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'transcription-reconcile-')); const source = recording();
  const client = { get: async () => source, downloadToFile: async (_id, destination) => writeFile(destination, 'audio', { flag: 'wx' }) };
  const service = new StudioService({ databasePath: join(root, 'jobs.sqlite'), workDir: join(root, 'work'), client, processor: new TestTranscriptionProcessor() });
  const job = await service.acceptRecording(source, 'event-outbox'); await service.process(job.id);
  assert.equal((await service.list())[0].transcript.schema_version, 'demo.transcript.v1');
  assert.equal(await service.reconcileAuthorized(new Set()), 1); assert.equal((await service.list()).length, 0);
  assert.equal(await service.acceptRecording(source, 'late-file-synced'), null);
});

test('Studio reclaims interrupted durable jobs and removes their sensitive work directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-recover-')); const database = join(root, 'jobs.sqlite'); const source = recording('recording-recover'); const jobId = 'job-interrupted';
  const store = new SqliteStore(database); await store.update((items) => items.push({ id: jobId, event_id: 'event-interrupted', recording_id: source.id, state: 'processing', attempt: 1, recording: { id: source.id, device_id: source.device_id, attribute: source.attribute, media: source.media, timing: source.timing, source_firmware_version: source.source_firmware_version, resource_version: source.resource_version }, processor_kind: 'fixture', processor_version: 'fixture-v1', created_at: source.created_at, updated_at: source.updated_at, started_at: source.created_at, completed_at: null, error_code: null, error_message: null, transcript: null, transcript_revision: 0, revisions: [], audio_path: join(root, 'work', jobId, 'recording.wav'), playback_ready: false })); await store.close();
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'work', jobId), { recursive: true })); await writeFile(join(root, 'work', jobId, 'recording.wav'), 'sensitive');
  const service = new StudioService({ databasePath: database, workDir: join(root, 'work'), client: { get: async () => source, downloadToFile: async (_id, destination) => writeFile(destination, 'audio', { flag: 'wx' }) }, processor: new TestTranscriptionProcessor() });
  assert.equal(await service.recover(), 1);
  const deadline = Date.now() + 2000; let recovered;
  do { recovered = await service.get(jobId); if (recovered?.state === 'completed') break; await new Promise((resolve) => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.attempt, 2); assert.equal(existsSync(join(root, 'work', jobId, 'recording.wav')), false);
});

test('Studio persists successful Summary chunks and retries only the failed stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-summary-chunks-')); let calls = 0; let failedOnce = false;
  const summarizer = { kind: 'controlled', model: 'test', promptVersion: 'v1', ready: async () => true, summarize: async (transcript) => {
    calls += 1; if (calls === 2 && !failedOnce) { failedOnce = true; throw new Error('CONTROLLED_FAILURE'); }
    const first = transcript.segments[0]; return { schema_version: 'demo.meeting-summary.v1', recording_id: transcript.recording_id, title: '分块会议', overview: first.text, topics: [{ title: '议题', summary: first.text, segment_refs: [first.id] }], decisions: [{ text: first.text, segment_refs: [first.id] }], action_items: [{ text: first.text, assignee: null, due_at: null, segment_refs: [first.id] }], model: { provider: 'controlled', model: 'test', prompt_version: 'v1' } };
  } };
  const segments = Array.from({ length: 5 }, (_, index) => ({ id: `seg-${index}`, start_ms: index * 1000, end_ms: (index + 1) * 1000, text: `内容${index}`, speaker: null, confidence: 0.9 }));
  const transcript = { schema_version: 'demo.transcript.v1', recording_id: 'meeting-chunked', language: 'zh', duration_ms: 5000, text: segments.map((item) => item.text).join(' '), segments, processor: { provider: 'test', model: 'test', version: '1' } };
  const source = recording('meeting-chunked');
  const service = new StudioService({
    databasePath: join(root, 'jobs.sqlite'), workDir: join(root, 'work'), summaryProcessor: { ...summarizer, version: '1' }, maxChunkSegments: 2, maxChunkCharacters: 1000,
    client: { get: async () => source, downloadToFile: async (_id, destination) => writeFile(destination, 'audio', { flag: 'wx' }) },
    processor: { kind: 'test', version: '1', ready: async () => true, transcribe: async () => transcript },
  });
  const job = await service.acceptRecording(source, 'summary-chunk-event'); await service.process(job.id);
  assert.equal((await service.get(job.id)).summary_state, 'failed'); assert.equal((await service.get(job.id)).summary_chunks.length, 1);
  await service.generateSummary(job.id);
  const completed = await service.get(job.id); assert.equal(completed.summary_state, 'completed'); assert.equal(completed.summary_chunks.length, 3); assert.equal(calls, 4);
});
