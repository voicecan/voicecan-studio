import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioService } from '../dist/service.js';
import { createStudioServer } from '../dist/web.js';

const root = await mkdtemp(join(tmpdir(), 'voicecan-studio-browser-'));
const recording = {
  id: 'rec-browser-demo', device_id: 'capso-browser-01', session_id: 1, attribute: 2, revision: 1,
  expected_size: 5, actual_size: 5, sha256: null, status: 'synced', transport: 's3',
  media: { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 125000, encoding_profile: 'browser-test', source: 'server_verified' },
  timing: { device_started_at: '2026-08-12T09:30:00+08:00', device_ended_at: '2026-08-12T09:32:05+08:00', duration_ms: 125000, device_timezone_offset_minutes: 480, discovered_at: '2026-08-12T09:33:00+08:00', synced_at: '2026-08-12T09:34:00+08:00' },
  source_firmware_version: 'browser-test', resource_version: 1, created_at: '2026-08-12T09:33:00+08:00', synced_at: '2026-08-12T09:34:00+08:00', legal_hold: false, legal_hold_reason: null, deletion_status: 'active', deletion_requested_at: null, object_deleted_at: null,
};
const transcript = {
  schema_version: 'demo.transcript.v1', recording_id: recording.id, language: 'zh', duration_ms: 125000,
  text: '团队确认统一 Studio 本周进入验收。External 和 Local Full 使用同一条录音链路。发布前必须由操作者确认当前纪要。',
  segments: [
    { id: 'seg-0001', start_ms: 0, end_ms: 41000, text: '团队确认统一 Studio 本周进入验收。', speaker: '主持人', confidence: 0.98 },
    { id: 'seg-0002', start_ms: 41000, end_ms: 85000, text: 'External 和 Local Full 使用同一条录音链路。', speaker: '工程师', confidence: 0.96 },
    { id: 'seg-0003', start_ms: 85000, end_ms: 125000, text: '发布前必须由操作者确认当前纪要。', speaker: '安全负责人', confidence: 0.97 },
  ],
  processor: { provider: 'browser-test', model: 'fixture-asr', version: '1' },
};
const summary = {
  schema_version: 'demo.meeting-summary.v1', recording_id: recording.id, title: '统一 Studio 验收会',
  overview: '团队确认统一工作台进入验收，并固定两个发行档位与人工确认门禁。',
  topics: [{ title: '统一链路', summary: 'External 与 Local Full 共享 Recording 到 Delivery 的领域链路。', segment_refs: ['seg-0001', 'seg-0002'] }],
  decisions: [{ text: '只保留 External 与 Local Full。', segment_refs: ['seg-0002'] }],
  action_items: [{ text: '完成浏览器与真实环境发布验收。', assignee: '工程团队', due_at: '2026-08-15', segment_refs: ['seg-0003'] }],
  model: { provider: 'browser-test', model: 'fixture-summary', prompt_version: 'meeting-v1' },
};
const provider = {
  kind: 'courier', health: async () => ({ ok: true, detail: 'browser harness' }),
  submit: async () => ({ requestId: 'courier-browser-1' }),
  getStatus: async (requestId) => ({ requestId, status: 'DELIVERED', terminal: true, successful: true }),
  getHistory: async () => [{ type: 'DELIVERED', timestamp: new Date().toISOString() }],
  cancel: async (requestId) => ({ requestId, status: 'CANCELED', terminal: true, successful: false }),
};
const service = new StudioService({
  databasePath: join(root, 'studio.sqlite'), workDir: join(root, 'work'), notificationProvider: provider,
  client: { get: async () => recording, downloadToFile: async (_id, destination) => writeFile(destination, 'audio', { flag: 'wx' }) },
  processor: { kind: 'browser-test', version: '1', ready: async () => true, transcribe: async () => transcript },
  summaryProcessor: { kind: 'browser-test', model: 'fixture-summary', version: '1', promptVersion: 'meeting-v1', ready: async () => true, summarize: async () => summary },
});
const job = await service.acceptRecording(recording, 'browser-event');
await service.process(job.id);
const server = createStudioServer({
  service, deploymentProfile: 'external',
  syncRecordings: async () => ({ running: false, scanned: 1, created: 0, failed: 0, removed: 0, completed_at: new Date().toISOString() }),
  syncStatus: () => ({ running: false, scanned: 1, created: 1, failed: 0, removed: 0, completed_at: new Date().toISOString() }),
  healthDiagnostics: async () => ({ ok: true, profile: 'external', processors: 'browser harness', notification: { ok: true } }),
});
server.listen(18911, '127.0.0.1', () => console.info('BROWSER_HARNESS_READY http://127.0.0.1:18911'));
const shutdown = async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
  await service.close();
};
process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
