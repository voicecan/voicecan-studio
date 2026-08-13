import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CourierNotificationProvider } from '../dist/notification-provider.js';
import { StudioService } from '../dist/service.js';

function recording(id = 'rec-unified') {
  return {
    id, device_id: 'dev-1', session_id: 1, attribute: 2, revision: 1,
    expected_size: 5, actual_size: 5, sha256: null, status: 'synced', transport: 's3',
    media: { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 30_000, encoding_profile: 'test', source: 'server_verified' },
    timing: { device_started_at: '2026-08-07T10:00:00Z', device_ended_at: '2026-08-07T10:00:30Z', duration_ms: 30_000, device_timezone_offset_minutes: 480, discovered_at: '2026-08-07T10:01:00Z', synced_at: '2026-08-07T10:02:00Z' },
    source_firmware_version: 'test', resource_version: 1, created_at: '2026-08-07T10:01:00Z', synced_at: '2026-08-07T10:02:00Z', legal_hold: false, legal_hold_reason: null, deletion_status: 'active', deletion_requested_at: null, object_deleted_at: null,
  };
}

function transcript(recordingId, text = '统一链路测试') {
  return {
    schema_version: 'demo.transcript.v1', recording_id: recordingId, language: 'zh', duration_ms: 30_000, text,
    segments: [{ id: 'seg-0001', start_ms: 0, end_ms: 30_000, text, speaker: 'Speaker 1', confidence: 1 }],
    processor: { provider: 'test', model: 'test-asr', version: '1' },
  };
}

function summary(value, promptVersion = 'meeting-v1') {
  const segment = value.segments[0];
  return {
    schema_version: 'demo.meeting-summary.v1', recording_id: value.recording_id, title: '统一会议纪要', overview: segment.text,
    topics: [{ title: '主题', summary: segment.text, segment_refs: [segment.id] }],
    decisions: [{ text: '采用统一链路', segment_refs: [segment.id] }],
    action_items: [{ text: '完成验收', assignee: null, due_at: null, segment_refs: [segment.id] }],
    model: { provider: 'test', model: 'test-summary', prompt_version: promptVersion },
  };
}

async function fixture({ transcriptText = '统一链路测试' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-unified-'));
  let downloads = 0;
  let transcriptions = 0;
  let summaries = 0;
  let submits = 0;
  const provider = {
    kind: 'courier', health: async () => ({ ok: true, detail: 'stub' }),
    submit: async () => { submits += 1; return { requestId: 'courier-request-1' }; },
    getStatus: async (requestId) => ({ requestId, status: 'DELIVERED', terminal: true, successful: true }),
    getHistory: async () => [{ type: 'DELIVERED', timestamp: '2026-08-12T00:00:00.000Z' }],
    cancel: async (requestId) => ({ requestId, status: 'CANCELED', terminal: true, successful: false }),
  };
  const source = recording();
  const databasePath = join(root, 'studio.sqlite');
  const service = new StudioService({
    databasePath, workDir: join(root, 'work'), notificationProvider: provider, studioBaseUrl: 'http://127.0.0.1:8811',
    client: { get: async () => source, downloadToFile: async (_id, destination) => { downloads += 1; await writeFile(destination, 'audio', { flag: 'wx' }); } },
    processor: { kind: 'test', version: '1', ready: async () => true, transcribe: async () => { transcriptions += 1; return transcript(source.id, transcriptText); } },
    summaryProcessor: { kind: 'test', model: 'test-summary', version: '1', promptVersion: 'meeting-v1', ready: async () => true, summarize: async (value) => { summaries += 1; return summary(value); } },
  });
  return { service, source, databasePath, counts: () => ({ downloads, transcriptions, summaries, submits }) };
}

test('one Recording is downloaded and transcribed once before Summary is generated', async () => {
  const { service, source, counts } = await fixture();
  const job = await service.acceptRecording(source, 'event-1');
  await service.process(job.id);
  const completed = await service.get(job.id);
  assert.deepEqual(counts(), { downloads: 1, transcriptions: 1, summaries: 1, submits: 0 });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.summary_state, 'completed');
  assert.equal(completed.summary_revision, 1);
  assert.equal(completed.summary_revisions[0].source_transcript_revision, 1);
  assert.match(await service.summaryMarkdown(job.id), /来源：\[seg-0001/);
});

test('empty Transcript skips Summary generation without recording a failure', async () => {
  const { service, source, counts } = await fixture({ transcriptText: '' });
  const job = await service.acceptRecording(source, 'event-empty-transcript');
  await service.process(job.id);
  const completed = await service.get(job.id);
  assert.deepEqual(counts(), { downloads: 1, transcriptions: 1, summaries: 0, submits: 0 });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.summary_state, 'skipped');
  assert.equal(completed.summary_error_code, null);
  assert.equal(completed.summary_error_message, null);
  assert.equal(completed.scenario_state, 'waiting');
  assert.equal((await service.metrics())['summaries.skipped'], 1);
});

test('empty Transcript can be saved idempotently and replaced with manual text', async () => {
  const { service, source, databasePath } = await fixture({ transcriptText: '' });
  const job = await service.acceptRecording(source, 'event-empty-transcript-manual');
  await service.process(job.id);
  const empty = await service.get(job.id);

  const unchanged = await service.revise(job.id, empty.transcript, 'editor', null);
  assert.equal(unchanged.transcript_revision, 1);

  const manual = await service.revise(job.id, transcript(source.id, '这是手动补充的完整转写'), 'editor', null);
  assert.equal(manual.transcript_revision, 2);
  assert.equal(manual.transcript.text, '这是手动补充的完整转写');
  assert.equal(manual.summary_state, 'not_requested');

  const database = new DatabaseSync(databasePath);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_transcript_revisions').get().value, 2);
  database.close();
});

test('Transcript revision marks processor and Scenario results stale', async () => {
  const { service, source } = await fixture();
  const job = await service.acceptRecording(source, 'event-2');
  await service.process(job.id);
  await service.confirmScenario(job.id, 'reviewer', 'checked');
  await service.revise(job.id, transcript(source.id, '修订后的转写'), 'editor', null);
  const revised = await service.get(job.id);
  assert.equal(revised.summary_state, 'stale');
  assert.equal(revised.scenario_state, 'stale');
  assert.equal(revised.scenario_confirmation, null);
  await assert.rejects(service.confirmScenario(job.id), /SCENARIO_NOT_CONFIRMABLE/);
});

test('confirmed Scenario creates and executes an idempotent Action without Transcript or audio data', async () => {
  const { service, source, counts } = await fixture();
  const job = await service.acceptRecording(source, 'event-3');
  await service.process(job.id);
  await assert.rejects(service.createActionIntent(job.id, target()), /SCENARIO_NOT_CONFIRMED/);
  await service.confirmScenario(job.id, 'reviewer');
  const first = await service.createActionIntent(job.id, target());
  const second = await service.createActionIntent(job.id, target());
  assert.equal(first.id, second.id);
  const executed = await service.executeActionIntent(job.id, first.id);
  assert.equal(executed.state, 'submitted');
  assert.equal(counts().submits, 1);
  assert.equal('transcript' in first.preview, false);
  assert.equal('audio_url' in first.preview, false);
  const current = await service.get(job.id);
  const delivered = await service.refreshDelivery(job.id, current.deliveries[0].id);
  assert.equal(delivered.state, 'delivered');
});

test('Scenario Pack closes the loop from source artifact to reviewed Courier action', async () => {
  const { service, source, counts } = await fixture();
  const job = await service.acceptRecording(source, 'event-scenario-loop');
  await service.process(job.id);

  const projected = await service.get(job.id);
  assert.equal(projected.scenario_id, 'meeting-interview');
  assert.equal(projected.scenario_state, 'completed');
  assert.equal(projected.scenario_result.values.topic_count, 1);
  assert.match(projected.scenario_result.title, /^会议纪要：/);
  assert.deepEqual(projected.scenario_result.sections.map((item) => item.title), ['议题与观点', '已确认决策', '行动项与负责人']);
  assert.deepEqual(projected.artifacts.map((item) => item.kind), ['transcript', 'summary', 'scenario-result']);
  assert.deepEqual(projected.artifacts.map((item) => item.parent_artifact_ids.length), [0, 1, 1]);
  assert.equal(projected.artifacts.every((item) => /^[a-f0-9]{64}$/.test(item.payload_hash)), true);

  await assert.rejects(service.createActionIntent(job.id, target()), /SCENARIO_NOT_CONFIRMED/);
  await service.confirmScenario(job.id, 'scenario-reviewer', 'checked');
  const draft = await service.createActionIntent(job.id, target());
  assert.equal(draft.state, 'draft');
  assert.equal(draft.preview.schema_version, 'studio.scenario-notification.v1');
  assert.equal('transcript' in draft.preview, false);
  const executed = await service.executeActionIntent(job.id, draft.id);
  assert.equal(executed.state, 'submitted');
  assert.equal(counts().submits, 1);
  const accepted = await service.get(job.id);
  await service.refreshDelivery(job.id, accepted.deliveries[0].id);
  const completed = await service.get(job.id);
  assert.equal(completed.action_intents[0].state, 'completed');
  assert.equal(completed.deliveries[0].scenario_revision, completed.scenario_revision);
  assert.match(await service.scenarioMarkdown(job.id), /Scenario meeting-interview@1\.1\.0/);
});

test('built-in scenarios can be switched without retranscribing the Recording', async () => {
  const { service, source, counts } = await fixture();
  const job = await service.acceptRecording(source, 'event-scenario-switch');
  await service.process(job.id);
  await service.selectScenario(job.id, 'field-report');
  const field = await service.get(job.id);
  assert.equal(field.scenario_result.values.equipment_id, 'dev-1');
  assert.match(field.scenario_result.title, /^现场报告：/);
  assert.deepEqual(field.scenario_result.sections.map((item) => item.title), ['现场发现', '处理结论', '后续处理']);
  assert.equal(field.scenario_revision, 2);
  await service.selectScenario(job.id, 'voice-inbox');
  const inbox = await service.get(job.id);
  assert.equal(inbox.scenario_result.values.task_count, 1);
  assert.match(inbox.scenario_result.title, /^语音备忘：/);
  assert.deepEqual(inbox.scenario_result.sections.map((item) => item.title), ['速记要点', '待办清单', '已记录决定']);
  assert.equal(inbox.scenario_revision, 3);
  assert.deepEqual(counts(), { downloads: 1, transcriptions: 1, summaries: 1, submits: 0 });
});

test('Courier provider uses SDK send and message status APIs', async () => {
  let sent;
  const client = {
    send: { message: async (params) => { sent = params; return { requestId: 'request-42' }; } },
    messages: {
      list: async () => ({ paging: { more: false }, results: [] }),
      retrieve: async () => ({ id: 'request-42', enqueued: 1, event: 'x', notification: 'x', recipient: 'x', status: 'DELIVERED' }),
      history: async () => ({ results: [{ type: 'DELIVERED', ts: 1_786_406_400_000 }] }),
      cancel: async () => ({ id: 'request-42', enqueued: 1, event: 'x', notification: 'x', recipient: 'x', status: 'CANCELED' }),
    },
  };
  const provider = new CourierNotificationProvider({ client });
  const result = await provider.submit({ target: target(), payload: { schema_version: 'studio.scenario-notification.v1', recording_id: 'rec', scenario_id: 'voice-inbox', scenario_revision: 1, title: 'title', overview: 'overview', values: {}, actions: [], studio_url: null, confirmed_at: '2026-08-12T00:00:00.000Z', confirmed_by: 'reviewer' }, idempotencyKey: 'idem-1' });
  assert.equal(result.requestId, 'request-42');
  assert.equal(sent['Idempotency-Key'], 'idem-1');
  assert.equal(sent.message.template, 'summary-ready');
  assert.equal((await provider.getStatus('request-42')).status, 'DELIVERED');
  assert.equal((await provider.getHistory('request-42'))[0].type, 'DELIVERED');
});

test('unified SQLite schema projects revision, confirmation, target and delivery invariants', async () => {
  const { service, source, databasePath } = await fixture();
  const job = await service.acceptRecording(source, 'event-schema');
  await service.process(job.id);
  await service.confirmScenario(job.id, 'schema-reviewer');
  const action = await service.createActionIntent(job.id, target());
  await service.executeActionIntent(job.id, action.id);
  await service.close();

  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_schema_migrations WHERE version=1').get().value, 1);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_recordings').get().value, 1);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_transcript_revisions').get().value, 1);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_summary_revisions').get().value, 1);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_notification_targets').get().value, 1);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_delivery_intents').get().value, 1);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_artifacts').get().value, 3);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_scenario_revisions').get().value, 1);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_scenario_confirmations').get().value, 1);
  assert.equal(database.prepare('SELECT count(*) AS value FROM studio_action_intents').get().value, 1);
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();
});

function target() {
  return { id: 'ops', name: 'Operations', recipient: { kind: 'user', user_id: 'user-1' }, workflow_id: 'summary-ready', routing: ['email', 'inbox'], version: 1 };
}
