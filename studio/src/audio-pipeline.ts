import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RecordingMediaDescriptor } from '@voicecan/contracts';
import { ensureParent } from './shared/index.js';

type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv };
export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<void>;

export type PreparedAudio = {
  transcriptionPath: string;
  playbackPath: string;
  transcriptionMedia: RecordingMediaDescriptor;
};

export type AudioPipeline = {
  assertReady(media: RecordingMediaDescriptor): Promise<void>;
  prepare(input: { sourcePath: string; workspace: string; media: RecordingMediaDescriptor }): Promise<PreparedAudio>;
};

const LC3_MAGICS = new Set([0x1cc3, 0x1ccc]);

function isLc3(media: RecordingMediaDescriptor): boolean {
  return media.encoding_profile === 'voicecan-lc3-v1'
    || media.content_type.toLowerCase() === 'audio/lc3'
    || media.codec?.toLowerCase() === 'lc3'
    || media.container?.toLowerCase() === 'lc3';
}

async function hasLc3Header(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 2 && LC3_MAGICS.has(header.readUInt16BE(0));
  } finally {
    await handle.close();
  }
}

const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolveCommand, reject) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolveCommand();
    else reject(new Error(`AUDIO_COMMAND_FAILED:${code ?? signal ?? 'unknown'}`));
  });
});

function decoderOptions(decoderPath: string): CommandOptions {
  const directory = dirname(resolve(decoderPath));
  const env = { ...process.env };
  if (process.platform === 'win32') {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
    env[pathKey] = `${directory};${env[pathKey] ?? ''}`;
  }
  else {
    const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    env[key] = `${directory}:${env[key] ?? ''}`;
  }
  return { cwd: directory, env };
}

export class FfmpegAudioPipeline implements AudioPipeline {
  readonly #ffmpegPath: string;
  readonly #lc3DecoderPath: string;
  readonly #run: CommandRunner;

  constructor(input: { ffmpegPath?: string; lc3DecoderPath?: string; runCommand?: CommandRunner } = {}) {
    this.#ffmpegPath = input.ffmpegPath ?? 'ffmpeg';
    this.#lc3DecoderPath = input.lc3DecoderPath ?? 'dlc3';
    this.#run = input.runCommand ?? runCommand;
  }

  async assertReady(media: RecordingMediaDescriptor): Promise<void> {
    try { await this.#run(this.#ffmpegPath, ['-version']); }
    catch { throw new Error('FFMPEG_UNAVAILABLE'); }
    if (isLc3(media)) {
      try { await this.#run(this.#lc3DecoderPath, ['-h'], decoderOptions(this.#lc3DecoderPath)); }
      catch { throw new Error('LC3_DECODER_UNAVAILABLE'); }
    }
  }

  async prepare(input: { sourcePath: string; workspace: string; media: RecordingMediaDescriptor }): Promise<PreparedAudio> {
    const normalizedPath = resolve(input.workspace, 'normalized.wav');
    const playbackPath = resolve(input.workspace, 'playback.m4a');
    const decodedPath = resolve(input.workspace, 'decoded.wav');
    await ensureParent(normalizedPath);

    let ffmpegInput = input.sourcePath;
    if (isLc3(input.media)) {
      if (!(await hasLc3Header(input.sourcePath))) throw new Error('LC3_HEADER_INVALID');
      try {
        await this.#run(this.#lc3DecoderPath, [resolve(input.sourcePath), decodedPath], decoderOptions(this.#lc3DecoderPath));
      } catch {
        throw new Error('LC3_DECODE_FAILED');
      }
      ffmpegInput = decodedPath;
    }

    try {
      await this.#run(this.#ffmpegPath, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', resolve(ffmpegInput), '-vn',
        '-af', 'afftdn=nr=12:nf=-50:tn=1', '-c:a', 'pcm_s16le', normalizedPath,
      ]);
    } catch {
      throw new Error('AUDIO_NORMALIZATION_FAILED');
    }

    try {
      await this.#run(this.#ffmpegPath, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', normalizedPath, '-vn',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', playbackPath,
      ]);
    } catch {
      throw new Error('PLAYBACK_ENCODING_FAILED');
    }

    return {
      transcriptionPath: normalizedPath,
      playbackPath,
      transcriptionMedia: {
        ...input.media,
        container: 'wav', codec: 'pcm_s16le', content_type: 'audio/wav', filename_extension: 'wav',
        bit_depth: 16, encoding_profile: 'voicecan-denoised-pcm-v1', source: 'server_verified',
      },
    };
  }
}
