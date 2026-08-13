import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FfmpegAudioPipeline } from '../dist/audio-pipeline.js';

const LC3_MEDIA = {
  schema_version: 'recording.media.v1', container: 'lc3', codec: 'lc3', content_type: 'audio/lc3',
  filename_extension: 'lc3', sample_rate_hz: null, channels: null, bit_depth: null, duration_ms: null,
  encoding_profile: 'voicecan-lc3-v1', source: 'firmware_mapping',
};

test('LC3 is decoded, denoised to PCM WAV, and encoded as fast-start M4A', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-audio-'));
  const source = join(root, 'recording.lc3');
  await writeFile(source, Buffer.from([0x1c, 0xcc, 0x00, 0x00]));
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    const output = args.at(-1);
    if (output?.endsWith('.wav') || output?.endsWith('.m4a')) await writeFile(output, command === 'dlc3-test' ? 'decoded' : 'converted');
  };
  const pipeline = new FfmpegAudioPipeline({ ffmpegPath: 'ffmpeg-test', lc3DecoderPath: 'dlc3-test', runCommand });

  await pipeline.assertReady(LC3_MEDIA);
  const result = await pipeline.prepare({ sourcePath: source, workspace: root, media: LC3_MEDIA });

  assert.equal(calls.filter((call) => call.command === 'dlc3-test').length, 2);
  assert.ok(calls.some((call) => call.args.includes('afftdn=nr=12:nf=-50:tn=1')));
  assert.ok(calls.some((call) => call.args.includes('+faststart') && call.args.includes('aac')));
  assert.equal(result.transcriptionMedia.content_type, 'audio/wav');
  assert.equal(result.transcriptionMedia.encoding_profile, 'voicecan-denoised-pcm-v1');
  assert.equal((await readFile(result.playbackPath, 'utf8')), 'converted');
});

test('declared LC3 with an invalid header is rejected instead of trying another format', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-invalid-lc3-'));
  const source = join(root, 'recording.lc3');
  await writeFile(source, 'not-lc3');
  const pipeline = new FfmpegAudioPipeline({ runCommand: async () => {} });
  await assert.rejects(pipeline.prepare({ sourcePath: source, workspace: root, media: LC3_MEDIA }), /LC3_HEADER_INVALID/);
});
