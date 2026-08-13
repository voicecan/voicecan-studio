import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { API_VERSION } from '@voicecan/contracts';
import { StudioService } from '../dist/service.js';

class TestTranscriptionProcessor {
  kind = 'test';
  version = 'test-v1';
  async ready() { return true; }
  async transcribe(input) {
    const duration = input.media.duration_ms ?? 1000;
    const segments = [{ id: 'seg-0001', start_ms: 0, end_ms: duration, text: 'test transcript', speaker: 'Speaker 1', confidence: 1 }];
    return { schema_version: 'demo.transcript.v1', recording_id: input.recording_id, language: 'en', duration_ms: duration, text: 'test transcript', segments, processor: { provider: 'test', model: 'test', version: this.version } };
  }
}

function recording(overrides = {}) {
  return {
    id: 'rec-1', device_id: 'dev-1', session_id: 1, attribute: 2, revision: 1,
    expected_size: 5, actual_size: 5, sha256: null, status: 'synced', transport: 's3',
    media: { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 30_000, encoding_profile: 'fixture-wav', source: 'server_verified' },
    timing: { device_started_at: '2026-08-07T10:00:00Z', device_ended_at: '2026-08-07T10:00:30Z', duration_ms: 30_000, device_timezone_offset_minutes: 480, discovered_at: '2026-08-07T10:01:00Z', synced_at: '2026-08-07T10:02:00Z' },
    source_firmware_version: 'fixture', resource_version: 1, created_at: '2026-08-07T10:01:00Z', synced_at: '2026-08-07T10:02:00Z', legal_hold: false, legal_hold_reason: null, deletion_status: 'active', deletion_requested_at: null, object_deleted_at: null,
    ...overrides,
  };
}

function event(id = 'evt-1') { return { id, type: 'file.synced', api_version: API_VERSION, created_at: '2026-08-07T10:02:00Z', data: { file_id: 'rec-1' } }; }

test('ten duplicate webhooks create one verified transcription job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-')); let downloads = 0;
  const client = { get: async () => recording(), downloadToFile: async (_id, destination) => { downloads += 1; await writeFile(destination, 'audio', { flag: 'wx' }); } };
  const service = new StudioService({ databasePath: join(root, 'jobs.json'), workDir: join(root, 'work'), client, processor: new TestTranscriptionProcessor() });
  const accepted = await Promise.all(Array.from({ length: 10 }, () => service.acceptEvent(event())));
  await service.process(accepted[0].id);
  const jobs = await service.list();
  assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'completed'); assert.equal(downloads, 1);
  assert.equal(jobs[0].transcript.schema_version, 'demo.transcript.v1');
  assert.match((await service.export(jobs[0].id, 'srt')).body, /00:00:00,000/);
  await assert.rejects(access(join(root, 'work', jobs[0].id, 'recording.wav')));
});

test('startup synchronization and later webhook delivery deduplicate by recording id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-sync-dedupe-'));
  const client = { get: async () => recording(), downloadToFile: async (_id, destination) => { await writeFile(destination, 'audio', { flag: 'wx' }); } };
  const service = new StudioService({ databasePath: join(root, 'jobs.json'), workDir: join(root, 'work'), client, processor: new TestTranscriptionProcessor() });
  await service.acceptRecording(recording(), 'platform-sync:rec-1:1');
  await service.acceptRecording(recording(), 'webhook-event-different-id');
  assert.equal((await service.list()).length, 1);
  await service.drain();
});

test('local job scheduler persists excess work as FIFO jobs and runs one pipeline at a time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-job-queue-'));
  let active = 0; let maxActive = 0;
  const completionOrder = [];
  const processor = {
    kind: 'queued-local', version: '1', ready: async () => true,
    transcribe: async (input) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1; completionOrder.push(input.recording_id);
      return { schema_version: 'demo.transcript.v1', recording_id: input.recording_id, language: 'zh', duration_ms: 1000, text: input.recording_id, segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1000, text: input.recording_id, speaker: null, confidence: 1 }], processor: { provider: 'test', model: 'test', version: '1' } };
    },
  };
  const recordings = new Map(Array.from({ length: 4 }, (_, index) => {
    const value = recording({ id: `queued-${index + 1}` });
    return [value.id, value];
  }));
  const service = new StudioService({
    databasePath: join(root, 'jobs.sqlite'), workDir: join(root, 'work'), maxConcurrentJobs: 1, processor,
    client: { get: async (id) => recordings.get(id), downloadToFile: async (_id, destination) => { await writeFile(destination, 'audio', { flag: 'wx' }); } },
  });
  const jobs = [];
  for (const item of recordings.values()) jobs.push(await service.acceptRecording(item, `queue-event:${item.id}`));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(service.queueDiagnostics(), { active: 1, queued: 3, concurrency_limit: 1, policy: 'fifo' });
  await service.drain();
  assert.equal(maxActive, 1);
  assert.deepEqual(completionOrder, ['queued-1', 'queued-2', 'queued-3', 'queued-4']);
  assert.ok((await Promise.all(jobs.map((job) => service.get(job.id)))).every((job) => job.state === 'completed'));
});

test('unavailable processor does not consume a grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-unavailable-')); let downloads = 0;
  const processor = { kind: 'down', version: '1', ready: async () => false, transcribe: async () => { throw new Error('unexpected'); } };
  const service = new StudioService({ databasePath: join(root, 'jobs.json'), workDir: join(root, 'work'), client: { get: async () => recording(), downloadToFile: async () => { downloads += 1; } }, processor });
  const job = await service.acceptEvent(event('evt-down')); await service.process(job.id);
  assert.equal((await service.get(job.id)).error_code, 'PROCESSOR_UNAVAILABLE'); assert.equal(downloads, 0);
});

test('storage pressure fails before consuming a download grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-storage-pressure-')); let downloads = 0;
  const service = new StudioService({
    databasePath: join(root, 'jobs.sqlite'), workDir: join(root, 'work'),
    client: { get: async () => recording(), downloadToFile: async () => { downloads += 1; } },
    processor: new TestTranscriptionProcessor(), storageProbe: async () => ({ total_bytes: 100, free_bytes: 5, used_ratio: 0.95 }),
  });
  const job = await service.acceptRecording(recording(), 'storage-pressure-event'); await service.process(job.id);
  assert.equal((await service.get(job.id)).error_code, 'STORAGE_PRESSURE'); assert.equal(downloads, 0);
});

test('missing LC3 or FFmpeg tooling does not consume a download grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-tools-unavailable-')); let downloads = 0;
  const service = new StudioService({
    databasePath: join(root, 'jobs.json'), workDir: join(root, 'work'),
    client: { get: async () => recording(), downloadToFile: async () => { downloads += 1; } },
    processor: new TestTranscriptionProcessor(),
    audioPipeline: { assertReady: async () => { throw new Error('FFMPEG_UNAVAILABLE'); }, prepare: async () => { throw new Error('unexpected'); } },
  });
  const job = await service.acceptEvent(event('evt-tools-down')); await service.process(job.id);
  assert.equal((await service.get(job.id)).error_code, 'FFMPEG_UNAVAILABLE'); assert.equal(downloads, 0);
});

test('cancel aborts an active SDK download and keeps the terminal state canceled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-cancel-')); let abortObserved = false;
  const client = {
    get: async () => recording(),
    downloadToFile: async (_id, _destination, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { abortObserved = true; reject(options.signal.reason); }, { once: true });
    }),
  };
  const service = new StudioService({ databasePath: join(root, 'jobs.sqlite'), workDir: join(root, 'work'), client, processor: new TestTranscriptionProcessor() });
  const job = await service.acceptRecording(recording(), 'cancel-event');
  for (let attempt = 0; attempt < 100 && (await service.get(job.id)).state !== 'downloading'; attempt += 1) await delay(5);
  await service.cancel(job.id);
  await service.process(job.id);
  assert.equal(abortObserved, true);
  assert.equal((await service.get(job.id)).state, 'canceled');
});

test('unknown media defaults to LC3 and continues through the processing pipeline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-unknown-')); let downloads = 0;
  const unknown = recording({ media: { schema_version: 'recording.media.v1', container: null, codec: null, content_type: 'application/octet-stream', filename_extension: 'bin', sample_rate_hz: null, channels: null, bit_depth: null, duration_ms: null, encoding_profile: null, source: 'unknown' } });
  let observedMedia = null;
  const audioPipeline = {
    assertReady: async (media) => { observedMedia = media; },
    prepare: async ({ sourcePath, media }) => {
      observedMedia = media;
      return { transcriptionPath: sourcePath, playbackPath: null, transcriptionMedia: { ...media, container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', bit_depth: 16 } };
    },
  };
  const service = new StudioService({ databasePath: join(root, 'jobs.json'), workDir: join(root, 'work'), client: { get: async () => unknown, downloadToFile: async (_id, destination) => { downloads += 1; await writeFile(destination, 'lc3-audio', { flag: 'wx' }); } }, processor: new TestTranscriptionProcessor(), audioPipeline });
  const job = await service.acceptEvent(event('evt-unknown'));
  await service.process(job.id);
  const completed = await service.get(job.id);
  assert.equal(completed.state, 'completed'); assert.equal(completed.error_code, null); assert.equal(downloads, 1);
  assert.equal(completed.recording.media.content_type, 'audio/lc3'); assert.equal(completed.recording.media.encoding_profile, 'voicecan-lc3-v1');
  assert.equal(observedMedia.codec, 'lc3'); assert.equal(observedMedia.sample_rate_hz, 16_000); assert.equal(observedMedia.channels, 1);
});
