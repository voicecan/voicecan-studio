import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StudioRuntime } from '../dist/runtime.js';

const unknownMedia = { schema_version: 'recording.media.v1', container: null, codec: null, content_type: 'application/octet-stream', filename_extension: 'bin', sample_rate_hz: null, channels: null, bit_depth: null, duration_ms: null, encoding_profile: null, source: 'unknown' };
function recording(id) {
  const now = '2026-08-11T00:00:00.000Z';
  return { id, device_id: 'device-1', session_id: 1, attribute: 0, revision: 1, expected_size: 4, actual_size: 4, sha256: null, status: 'synced', transport: 'fixture', error_code: null, media: unknownMedia, timing: { device_started_at: now, device_ended_at: now, duration_ms: null, device_timezone_offset_minutes: null, discovered_at: now, synced_at: now }, source_firmware_version: 'fixture', resource_version: 1, created_at: now, updated_at: now, synced_at: now, legal_hold: false, legal_hold_reason: null, deletion_status: 'active', deletion_requested_at: null, object_deleted_at: null };
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('saved Platform configuration is redacted and startup synchronization is idempotent', async (context) => {
  let listCalls = 0;
  const platform = createServer((request, response) => {
    if (request.url === '/healthz') { response.writeHead(200).end('ok'); return; }
    if (!request.headers.authorization?.startsWith('Bearer ')) { response.writeHead(401).end(); return; }
    if (request.url?.startsWith('/api/v1/recordings')) {
      listCalls += 1;
      const body = JSON.stringify({ success: true, code: '', message: 'success', data: { items: [recording('rec-a'), recording('rec-b')], next_cursor: null } });
      response.writeHead(200, { 'content-type': 'application/json' }).end(body); return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false, code: 'NOT_FOUND', message: 'not found' }));
  });
  context.after(() => new Promise((resolve) => platform.close(resolve)));
  const platformUrl = await listen(platform); const root = await mkdtemp(join(tmpdir(), 'studio-runtime-'));
  const paths = { configPath: join(root, 'config.json'), databasePath: join(root, 'jobs.json'), workDir: join(root, 'work') };
  const config = { platform_url: platformUrl, application_token: 'vcd_app_secret', webhook_secret: 'webhook-secret', webhook_secret_next: '', processor_kind: 'http', processor_endpoint: platformUrl, processor_api_key: '', summary_endpoint: platformUrl, summary_api_key: '', summary_model: 'test', summary_prompt_version: 'meeting-v1', notification_enabled: false, courier_api_key: '', courier_base_url: 'https://api.courier.com', studio_public_url: '', retention_days: 30 };
  const runtime = new StudioRuntime(paths);

  await runtime.configure(config);
  await runtime.sync();
  assert.equal(runtime.configured, true); assert.equal(runtime.publicConfig.application_token_configured, true);
  assert.equal('application_token' in runtime.publicConfig, false); assert.equal((await runtime.service.list()).length, 2);
  await runtime.sync();
  assert.equal((await runtime.service.list()).length, 2);
  assert.match(await readFile(paths.configPath, 'utf8'), /vcd_app_secret/);

  const restarted = new StudioRuntime(paths);
  await restarted.initialize();
  await restarted.sync();
  assert.equal((await restarted.service.list()).length, 2); assert.ok(listCalls >= 4);
});

test('external production configuration rejects a fixture processor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-real-only-'));
  const runtime = new StudioRuntime({ configPath: join(root, 'config.json'), databasePath: join(root, 'jobs.sqlite'), workDir: join(root, 'work') });
  await assert.rejects(runtime.configure({
    platform_url: 'https://device.example.com',
    application_token: 'vcd_app_secret',
    webhook_secret: 'vce_secret',
    webhook_secret_next: '',
    processor_kind: 'fixture',
    processor_endpoint: 'http://127.0.0.1:9001',
    processor_api_key: '',
    summary_endpoint: 'http://127.0.0.1:9002', summary_api_key: '', summary_model: 'test', summary_prompt_version: 'meeting-v1',
    notification_enabled: false, courier_api_key: '', courier_base_url: 'https://api.courier.com', studio_public_url: '',
    retention_days: 30,
  }), /PROCESSOR_KIND_INVALID/);
});
