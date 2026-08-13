import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LocalAsrProcessor } from '../dist/local-asr-processor.js';
import { processorFromEnvironment } from '../dist/main-local.js';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = resolve(projectRoot, 'test/fixtures/fake-local-asr-worker.py');
const registerModelPath = resolve(projectRoot, 'local-asr/register_model.py');
const python = process.platform === 'win32' ? resolve(projectRoot, 'local-asr/.venv/Scripts/python.exe') : 'python3';

test('local entrypoint derives the immutable model version from the delivered manifest', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'local-entry-model-'));
  const revision = '9'.repeat(40);
  await writeFile(join(root, 'voicecan-model-manifest.json'), JSON.stringify({
    schema_version: 'voicecan.local-asr-model.v1',
    repository: 'voicecan/faster-whisper-small',
    revision,
    files: [{ path: 'model.bin', size: 1, sha256: '0'.repeat(64) }],
  }));
  const previous = process.env.LOCAL_ASR_MODEL_PATH;
  process.env.LOCAL_ASR_MODEL_PATH = root;
  context.after(() => { if (previous === undefined) delete process.env.LOCAL_ASR_MODEL_PATH; else process.env.LOCAL_ASR_MODEL_PATH = previous; });
  const processor = await processorFromEnvironment();
  assert.equal(processor.version, `voicecan/faster-whisper-small@${revision}`);
});

test('embedded local worker transcribes from local files without receiving Voicecan credentials', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-local-asr-'));
  const model = join(root, 'model'); const audio = join(root, 'audio.wav');
  const revision = 'a'.repeat(40); const version = `fixture/local-model@${revision}`;
  await mkdir(model);
  const modelData = 'fixture-model';
  await writeFile(join(model, 'model.bin'), modelData);
  await writeFile(join(model, 'voicecan-model-manifest.json'), JSON.stringify({ schema_version: 'voicecan.local-asr-model.v1', repository: 'fixture/local-model', revision, files: [{ path: 'model.bin', size: Buffer.byteLength(modelData), sha256: createHash('sha256').update(modelData).digest('hex') }] }));
  await writeFile(audio, 'local-audio');
  const previousToken = process.env.VOICECAN_APPLICATION_TOKEN;
  process.env.VOICECAN_APPLICATION_TOKEN = 'must-not-reach-worker';
  context.after(() => { if (previousToken === undefined) delete process.env.VOICECAN_APPLICATION_TOKEN; else process.env.VOICECAN_APPLICATION_TOKEN = previousToken; });
  const processor = new LocalAsrProcessor({
    python,
    workerPath,
    modelPath: model,
    modelVersion: version,
    device: 'cpu',
    computeType: 'int8',
    timeoutMs: 10_000,
  });
  context.after(() => processor.close());
  assert.equal(await processor.ready(), true);
  assert.equal(processor.diagnostics().requested_device, 'cpu');
  assert.equal(processor.diagnostics().device, 'cpu');
  assert.equal(processor.diagnostics().compute_type, 'int8');
  const transcript = await processor.transcribe({ audio_path: audio, recording_id: 'recording-local', media: { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 2500, encoding_profile: 'local-test', source: 'server_verified' } });
  assert.equal(transcript.text, '完全本地 独立转写');
  assert.equal(transcript.processor.provider, 'local-faster-whisper');
  assert.equal(transcript.processor.version, version);
  assert.equal(transcript.segments.length, 2);
});

test('local worker refuses a model directory whose manifest does not match configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-model-version-'));
  const model = join(root, 'model'); await mkdir(model);
  await writeFile(join(model, 'voicecan-model-manifest.json'), JSON.stringify({ schema_version: 'voicecan.local-asr-model.v1', repository: 'fixture/model', revision: 'b'.repeat(40) }));
  const processor = new LocalAsrProcessor({ python, workerPath, modelPath: model, modelVersion: `fixture/model@${'c'.repeat(40)}` });
  await assert.rejects(processor.ready(), /LOCAL_ASR_MODEL_VERSION_MISMATCH/);
});

test('offline model registration hashes local artifacts and detects later tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-model-register-'));
  const model = join(root, 'model'); await mkdir(model);
  await Promise.all([
    writeFile(join(model, 'model.bin'), 'model-content'),
    writeFile(join(model, 'config.json'), '{}'),
    writeFile(join(model, 'tokenizer.json'), '{}'),
  ]);
  const revision = 'd'.repeat(40); const version = `internal/local-model@${revision}`;
  await execFileAsync(python, [registerModelPath, '--repository', 'internal/local-model', '--revision', revision, '--model-path', model]);
  await writeFile(join(model, 'model.bin'), 'tampered-content');
  const processor = new LocalAsrProcessor({ python, workerPath, modelPath: model, modelVersion: version });
  await assert.rejects(processor.ready(), /LOCAL_ASR_MODEL_INTEGRITY_FAILED/);
});

test('local processor keeps excess work in a FIFO queue instead of rejecting it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-local-queue-')); const model = join(root, 'model'); await mkdir(model);
  const data = 'fixture-model'; const revision = 'e'.repeat(40); const version = `fixture/queue-model@${revision}`;
  await writeFile(join(model, 'model.bin'), data);
  await writeFile(join(model, 'voicecan-model-manifest.json'), JSON.stringify({ schema_version: 'voicecan.local-asr-model.v1', repository: 'fixture/queue-model', revision, files: [{ path: 'model.bin', size: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') }] }));
  const slow = join(root, 'slow.wav'); const fast = join(root, 'fast.wav'); await writeFile(slow, 'audio'); await writeFile(fast, 'audio');
  const processor = new LocalAsrProcessor({ python, workerPath, modelPath: model, modelVersion: version, timeoutMs: 1000 });
  context.after(() => processor.close()); await processor.ready(); const media = { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 2500, encoding_profile: 'test', source: 'server_verified' };
  const completed = [];
  const first = processor.transcribe({ audio_path: slow, recording_id: 'slow', media }).then((result) => { completed.push(result.recording_id); return result; });
  await new Promise((resolveTick) => setImmediate(resolveTick));
  const second = processor.transcribe({ audio_path: fast, recording_id: 'fast', media }).then((result) => { completed.push(result.recording_id); return result; });
  const third = processor.transcribe({ audio_path: fast, recording_id: 'overflow', media }).then((result) => { completed.push(result.recording_id); return result; });
  assert.equal(processor.diagnostics().queued, 2);
  await Promise.all([first, second, third]);
  assert.deepEqual(completed, ['slow', 'fast', 'overflow']);
  assert.equal(processor.diagnostics().queued, 0);
  assert.equal(processor.diagnostics().queue_policy, 'fifo');
});

test('local processor restarts cleanly after a worker timeout and crash', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-local-restart-')); const model = join(root, 'model'); await mkdir(model);
  const data = 'fixture-model'; const revision = 'f'.repeat(40); const version = `fixture/restart-model@${revision}`;
  await writeFile(join(model, 'model.bin'), data);
  await writeFile(join(model, 'voicecan-model-manifest.json'), JSON.stringify({ schema_version: 'voicecan.local-asr-model.v1', repository: 'fixture/restart-model', revision, files: [{ path: 'model.bin', size: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') }] }));
  const hang = join(root, 'hang.wav'); const crash = join(root, 'crash.wav'); const ok = join(root, 'ok.wav'); await Promise.all([writeFile(hang, 'audio'), writeFile(crash, 'audio'), writeFile(ok, 'audio')]);
  const processor = new LocalAsrProcessor({ python, workerPath, modelPath: model, modelVersion: version, timeoutMs: 50 });
  context.after(() => processor.close()); const media = { schema_version: 'recording.media.v1', container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav', sample_rate_hz: 16000, channels: 1, bit_depth: 16, duration_ms: 2500, encoding_profile: 'test', source: 'server_verified' };
  await assert.rejects(processor.transcribe({ audio_path: hang, recording_id: 'hang', media }), /LOCAL_ASR_TIMEOUT/);
  assert.equal((await processor.transcribe({ audio_path: ok, recording_id: 'after-timeout', media })).recording_id, 'after-timeout');
  await assert.rejects(processor.transcribe({ audio_path: crash, recording_id: 'crash', media }), /LOCAL_ASR_EXITED/);
  assert.equal((await processor.transcribe({ audio_path: ok, recording_id: 'after-crash', media })).recording_id, 'after-crash');
});
