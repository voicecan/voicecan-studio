import assert from 'node:assert/strict';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StudioService } from '../studio/dist/service.js';
import { createStudioServer } from '../studio/dist/web.js';

class TestTranscriptionProcessor {
  kind = 'test';
  version = 'test-v1';
  async ready() { return true; }
  async transcribe(input) {
    const duration = input.media.duration_ms ?? 1000;
    const segments = [{ id: 'seg-0001', start_ms: 0, end_ms: duration, text: 'HTTP smoke transcript', speaker: null, confidence: 1 }];
    return {
      schema_version: 'demo.transcript.v1', recording_id: input.recording_id, language: 'en', duration_ms: duration,
      text: 'HTTP smoke transcript', segments, processor: { provider: 'test', model: 'http-smoke', version: this.version },
    };
  }
}

function recording(id) {
  const now = '2026-08-11T00:00:00.000Z';
  return {
    id, device_id: 'device-1', session_id: 1, attribute: 7, revision: 1,
    expected_size: 5, actual_size: 5, sha256: null, status: 'synced', transport: 'fixture', error_code: null,
    media: { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 5000, encoding_profile: 'fixture-wav', source: 'server_verified' },
    timing: { device_started_at: now, device_ended_at: now, duration_ms: 5000, device_timezone_offset_minutes: 480, discovered_at: now, synced_at: now },
    source_firmware_version: 'fixture', resource_version: 1, created_at: now, updated_at: now, synced_at: now,
    legal_hold: false, legal_hold_reason: null, deletion_status: 'active', deletion_requested_at: null, object_deleted_at: null,
  };
}

function recordingClient(source) {
  return {
    get: async () => source,
    downloadToFile: async (_id, destination) => writeFile(destination, 'audio', { flag: 'wx' }),
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('External and Local Full render the unified Recording HTTP flow', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'voicecan-demo-http-'));
  const audioPipeline = {
    assertReady: async () => {},
    prepare: async ({ sourcePath, workspace, media }) => {
      const transcriptionPath = join(workspace, 'normalized.wav'); const playbackPath = join(workspace, 'playback.m4a');
      await copyFile(sourcePath, transcriptionPath); await writeFile(playbackPath, '0123456789');
      return { transcriptionPath, playbackPath, transcriptionMedia: { ...media, container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav' } };
    },
  };
  const externalRecording = recording('recording-external');
  const localRecording = recording('recording-local');
  const externalService = new StudioService({ databasePath: join(root, 'external.sqlite'), workDir: join(root, 'external-work'), client: recordingClient(externalRecording), processor: new TestTranscriptionProcessor(), audioPipeline });
  const localService = new StudioService({ databasePath: join(root, 'local.sqlite'), workDir: join(root, 'local-work'), client: recordingClient(localRecording), processor: new TestTranscriptionProcessor(), audioPipeline });
  const servers = [
    createStudioServer({ service: externalService, webhookSecret: 'unused', deploymentProfile: 'external' }),
    createStudioServer({ service: localService, webhookSecret: 'unused', deploymentProfile: 'local-full' }),
  ];
  context.after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));
  const [external, local] = await Promise.all(servers.map(listen));
  const pages = await Promise.all([external, local].map((base) => fetch(base).then((response) => response.text())));
  assert.match(pages[0], /Voicecan Studio/); assert.match(pages[1], /Voicecan Studio/);
  const runtimes = await Promise.all([external, local].map((base) => fetch(`${base}/api/runtime`).then((response) => response.json())));
  assert.deepEqual(runtimes.map((runtime) => runtime.profile), ['external', 'local-full']);
  await Promise.all([
    externalService.acceptRecording(externalRecording, 'smoke:external'),
    localService.acceptRecording(localRecording, 'smoke:local'),
  ]);
  await Promise.all([externalService.drain(), localService.drain()]);
  const jobs = await Promise.all([external, local].map((base) => fetch(`${base}/api/v1/recordings`).then((response) => response.json())));
  assert.deepEqual(jobs.map((items) => items.length), [1, 1]);
  const partial = await fetch(`${external}/api/jobs/${jobs[0][0].id}/audio`, { headers: { range: 'bytes=2-5' } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-type'), 'audio/mp4'); assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
});
