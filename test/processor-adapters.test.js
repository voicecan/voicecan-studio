import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HttpTranscriptionProcessor } from '../studio/dist/shared/index.js';
import { validateMeetingSummary } from '../studio/dist/shared/index.js';
import { HttpSummaryProcessor } from '../studio/dist/summary-processor.js';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return new URL(`http://127.0.0.1:${server.address().port}`);
}

test('real HTTP transcription adapter streams verified local audio under its public contract', async (context) => {
  let received = Buffer.alloc(0);
  const server = createServer(async (request, response) => {
    if (request.url === '/healthz') { response.writeHead(200).end('ok'); return; }
    assert.equal(request.url, '/v1/transcribe'); assert.equal(request.headers.authorization, 'Bearer processor-key'); assert.match(request.headers['idempotency-key'], /^[a-f0-9]{64}$/);
    for await (const chunk of request) received = Buffer.concat([received, chunk]);
    const body = { schema_version: 'demo.transcript.v1', recording_id: request.headers['x-recording-id'], language: 'zh', duration_ms: 1000, text: '真实适配器', segments: [{ id: 'seg-0001', start_ms: 0, end_ms: 1000, text: '真实适配器', speaker: null, confidence: 0.9 }], processor: { provider: 'sandbox-asr', model: 'contract-model', version: 'immutable-1' } };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = await listen(server); const root = await mkdtemp(join(tmpdir(), 'studio-http-adapter-')); const audio = join(root, 'audio.wav');
  await writeFile(audio, 'streamed-audio');
  const processor = new HttpTranscriptionProcessor({ endpoint, apiKey: 'processor-key', kind: 'sandbox-asr', version: 'immutable-1' });
  assert.equal(await processor.ready(), true);
  const result = await processor.transcribe({ audio_path: audio, recording_id: 'recording-http', media: { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 1000, encoding_profile: 'voicecan-denoised-pcm-v1', source: 'server_verified' } });
  assert.equal(result.recording_id, 'recording-http'); assert.equal(received.toString(), 'streamed-audio');
});

test('real HTTP meeting adapter sends a versioned prompt request and accepts traceable output', async (context) => {
  const transcript = { schema_version: 'demo.transcript.v1', recording_id: 'meeting-http', language: 'zh', duration_ms: 1000, text: '确定发布', segments: [{ id: 'seg-0001', start_ms: 0, end_ms: 1000, text: '确定发布', speaker: 'Speaker 1', confidence: 0.95 }], processor: { provider: 'sandbox-asr', model: 'contract-model', version: '1' } };
  const server = createServer(async (request, response) => {
    if (request.url === '/healthz') { response.writeHead(200).end('ok'); return; }
    assert.equal(request.url, '/v1/meeting-summary'); assert.equal(request.headers.authorization, 'Bearer summary-key'); assert.match(request.headers['idempotency-key'], /^[a-f0-9]{64}$/);
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(input.prompt_version, 'meeting-contract-v1'); assert.equal(input.transcript.recording_id, transcript.recording_id);
    const summary = { schema_version: 'demo.meeting-summary.v1', recording_id: transcript.recording_id, title: '发布会', overview: '确定发布。', topics: [{ title: '发布', summary: '已确认。', segment_refs: ['seg-0001'] }], decisions: [{ text: '发布', segment_refs: ['seg-0001'] }], action_items: [{ text: '执行发布', assignee: null, due_at: null, segment_refs: ['seg-0001'] }], model: { provider: 'sandbox-llm', model: 'contract-model', prompt_version: 'meeting-contract-v1' } };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(summary));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const summarizer = new HttpSummaryProcessor({ endpoint: await listen(server), apiKey: 'summary-key', model: 'contract-model', promptVersion: 'meeting-contract-v1' });
  assert.equal(await summarizer.ready(), true); const summary = await summarizer.summarize(transcript); validateMeetingSummary(summary, transcript);
});

test('HTTP processor adapters surface upstream throttling and timeout failures', async (context) => {
  const transcript = { schema_version: 'demo.transcript.v1', recording_id: 'failure-injection', language: 'zh', duration_ms: 1000, text: '故障注入', segments: [{ id: 'seg-0001', start_ms: 0, end_ms: 1000, text: '故障注入', speaker: null, confidence: 0.9 }], processor: { provider: 'sandbox', model: 'test', version: '1' } };
  const server = createServer((request, response) => {
    if (request.url === '/v1/transcribe') { request.resume(); response.writeHead(429).end('throttled'); return; }
    if (request.url === '/v1/meeting-summary') { request.resume(); setTimeout(() => response.writeHead(500).end('late'), 200); return; }
    response.writeHead(200).end('ok');
  });
  context.after(() => new Promise((resolve) => server.close(resolve))); const endpoint = await listen(server);
  const root = await mkdtemp(join(tmpdir(), 'adapter-failures-')); const audio = join(root, 'audio.wav'); await writeFile(audio, 'audio');
  const processor = new HttpTranscriptionProcessor({ endpoint, timeoutMs: 100 });
  await assert.rejects(processor.transcribe({ audio_path: audio, recording_id: transcript.recording_id, media: { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 1000, encoding_profile: 'test', source: 'server_verified' } }), /PROCESSOR_HTTP_429/);
  const summarizer = new HttpSummaryProcessor({ endpoint, promptVersion: 'failure-v1', timeoutMs: 20 });
  await assert.rejects(summarizer.summarize(transcript), /timeout|aborted/i);
});
