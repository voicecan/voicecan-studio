import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { RecordingMediaDescriptor } from '@voicecan/contracts';
import type { TranscriptV1 } from './contracts.js';

export type TranscriptionInput = { audio_path: string; recording_id: string; media: RecordingMediaDescriptor; language_hint?: string };
export type TranscriptionProcessor = {
  kind: string;
  version: string;
  ready(): Promise<boolean>;
  transcribe(input: TranscriptionInput): Promise<TranscriptV1>;
};

export class HttpTranscriptionProcessor implements TranscriptionProcessor {
  readonly kind: string;
  readonly version: string;
  readonly #endpoint: URL;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;

  constructor(input: { endpoint: URL; apiKey?: string; kind?: string; version?: string; timeoutMs?: number }) {
    this.#endpoint = input.endpoint;
    this.#apiKey = input.apiKey;
    this.kind = input.kind ?? 'http';
    this.version = input.version ?? 'http-v1';
    this.#timeoutMs = input.timeoutMs ?? 30 * 60_000;
  }

  async ready(): Promise<boolean> {
    try { return (await fetch(new URL('/healthz', this.#endpoint), { signal: AbortSignal.timeout(3_000), headers: this.#headers() })).ok; }
    catch { return false; }
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptV1> {
    const size = (await stat(input.audio_path)).size;
    const response = await fetch(new URL('/v1/transcribe', this.#endpoint), {
      method: 'POST',
      headers: { ...this.#headers(), 'content-type': input.media.content_type, 'content-length': String(size), 'x-recording-id': input.recording_id, 'x-media-profile': input.media.encoding_profile ?? '', 'idempotency-key': createHash('sha256').update(`${input.recording_id}:${this.kind}:${this.version}`).digest('hex') },
      body: createReadStream(input.audio_path) as unknown as BodyInit,
      duplex: 'half',
      signal: AbortSignal.timeout(this.#timeoutMs),
    } as RequestInit & { duplex: 'half' });
    if (!response.ok) throw new Error(`PROCESSOR_HTTP_${response.status}`);
    const body = await response.text(); if (body.length > 10 * 1024 * 1024) throw new Error('PROCESSOR_RESPONSE_TOO_LARGE');
    return JSON.parse(body) as TranscriptV1;
  }

  #headers(): Record<string, string> {
    return this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
  }
}

