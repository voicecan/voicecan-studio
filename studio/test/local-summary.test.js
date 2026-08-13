import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LocalSummaryProcessor } from '../dist/local-summary-processor.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = resolve(projectRoot, 'test/fixtures/fake-local-summary-worker.py');
const python = process.platform === 'win32' ? resolve(projectRoot, 'local-summary/.venv/Scripts/python.exe') : 'python3';

test('embedded local Summary worker uses verified files without receiving service secrets', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'local-summary-')); const model = join(root, 'model'); await mkdir(model);
  const data = 'fake-gguf'; const revision = '7'.repeat(40); const version = `fixture/local-summary@${revision}`;
  await writeFile(join(model, 'model.gguf'), data);
  await writeFile(join(model, 'voicecan-model-manifest.json'), JSON.stringify({ schema_version: 'voicecan.local-summary-model.v1', repository: 'fixture/local-summary', revision, files: [{ path: 'model.gguf', size: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') }] }));
  const previousToken = process.env.VOICECAN_APPLICATION_TOKEN; const previousCourier = process.env.COURIER_API_KEY;
  process.env.VOICECAN_APPLICATION_TOKEN = 'must-not-reach-worker'; process.env.COURIER_API_KEY = 'must-not-reach-worker';
  context.after(() => { previousToken === undefined ? delete process.env.VOICECAN_APPLICATION_TOKEN : process.env.VOICECAN_APPLICATION_TOKEN = previousToken; previousCourier === undefined ? delete process.env.COURIER_API_KEY : process.env.COURIER_API_KEY = previousCourier; });
  const processor = new LocalSummaryProcessor({ python, workerPath, modelPath: model, modelVersion: version, contextSize: 4096, maxTokens: 512, timeoutMs: 10_000 });
  context.after(() => processor.close());
  const transcript = { schema_version: 'demo.transcript.v1', recording_id: 'local-summary-recording', language: 'zh', duration_ms: 1000, text: '仅在本地总结', segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1000, text: '仅在本地总结', speaker: null, confidence: 1 }], processor: { provider: 'local', model: 'test', version: '1' } };
  assert.equal(await processor.ready(), true);
  assert.equal(processor.diagnostics().gpu_mode, 'prefer');
  assert.equal(processor.diagnostics().device, 'fixture');
  assert.equal(processor.diagnostics().gpu_layers, -1);
  assert.equal(processor.diagnostics().context_size, 4096);
  assert.equal(processor.diagnostics().max_tokens, 512);
  const summary = await processor.summarize(transcript);
  assert.equal(summary.title, '完全本地会议纪要'); assert.equal(summary.model.provider, 'local-llama-cpp');
});

test('local Summary worker rejects a modified model artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-summary-integrity-')); const model = join(root, 'model'); await mkdir(model);
  const revision = '8'.repeat(40);
  await writeFile(join(model, 'model.gguf'), 'modified');
  await writeFile(join(model, 'voicecan-model-manifest.json'), JSON.stringify({ schema_version: 'voicecan.local-summary-model.v1', repository: 'fixture/local-summary', revision, files: [{ path: 'model.gguf', size: 8, sha256: '0'.repeat(64) }] }));
  const processor = new LocalSummaryProcessor({ python, workerPath, modelPath: model, modelVersion: `fixture/local-summary@${revision}` });
  await assert.rejects(processor.ready(), /LOCAL_SUMMARY_MODEL_INTEGRITY_FAILED/);
});
