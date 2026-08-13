import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { API_VERSION } from '@voicecan/contracts';
import { createHttpServer, readJson, readVerifiedEvent, requireOperator, sendJson } from '../studio/dist/shared/index.js';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP boundary rejects DNS rebinding hosts, cross-origin mutation, and missing operator tokens', async (context) => {
  const previousToken = process.env.DEMO_OPERATOR_TOKEN; process.env.DEMO_OPERATOR_TOKEN = 'operator-secret';
  context.after(() => { if (previousToken === undefined) delete process.env.DEMO_OPERATOR_TOKEN; else process.env.DEMO_OPERATOR_TOKEN = previousToken; });
  const server = createHttpServer(async ({ request, response }) => { requireOperator(request); const body = await readJson(request, 32); sendJson(response, 200, body); });
  context.after(() => new Promise((resolve) => server.close(resolve))); const base = await listen(server);
  const target = new URL(base);
  const badHostStatus = await new Promise((resolve, reject) => { const request = httpRequest({ hostname: target.hostname, port: target.port, method: 'POST', headers: { host: 'evil.test', 'content-type': 'application/json', authorization: 'Bearer operator-secret' } }, (response) => { response.resume(); resolve(response.statusCode); }); request.once('error', reject); request.end('{}'); });
  assert.equal(badHostStatus, 403);
  const badOrigin = await fetch(base, { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json', authorization: 'Bearer operator-secret' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const missing = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(missing.status, 401);
  const tooLarge = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer operator-secret' }, body: JSON.stringify({ value: 'x'.repeat(100) }) }); assert.equal(tooLarge.status, 413);
  const ok = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer operator-secret' }, body: JSON.stringify({ ok: true }) });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true });
});

test('webhook verification accepts current and next secrets but rejects expired deliveries', async (context) => {
  const secrets = ['current-secret', 'next-secret'];
  const server = createHttpServer(async ({ request, response }) => { await readVerifiedEvent(request, secrets); response.writeHead(204).end(); });
  context.after(() => new Promise((resolve) => server.close(resolve))); const base = await listen(server);
  const body = JSON.stringify({ id: 'rotation-event', type: 'recording.deleted', api_version: API_VERSION, created_at: new Date().toISOString(), data: { file_id: 'recording-1' } });
  const send = (secret, timestamp) => {
    const delivery = crypto.randomUUID(); const signature = createHmac('sha256', secret).update(timestamp).update('.').update(delivery).update('.').update(body).digest('hex');
    return fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'voicecan-timestamp': timestamp, 'voicecan-delivery-id': delivery, 'voicecan-signature': `v1=${signature}` }, body });
  };
  assert.equal((await send('current-secret', String(Math.floor(Date.now() / 1000)))).status, 204);
  assert.equal((await send('next-secret', String(Math.floor(Date.now() / 1000)))).status, 204);
  assert.equal((await send('next-secret', String(Math.floor(Date.now() / 1000) - 3600))).status, 401);
});
