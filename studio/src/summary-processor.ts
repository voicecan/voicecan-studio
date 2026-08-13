import { createHash } from 'node:crypto';
import type { MeetingSummaryV1, TranscriptV1 } from './shared/index.js';

export type SummaryProcessor = {
  kind: string;
  model: string;
  version: string;
  promptVersion: string;
  ready(): Promise<boolean>;
  summarize(transcript: TranscriptV1): Promise<MeetingSummaryV1>;
};

export function summaryInputKey(transcript: TranscriptV1, processor: SummaryProcessor): string {
  return createHash('sha256')
    .update(JSON.stringify({ transcript, processor: processor.kind, model: processor.model, version: processor.version, prompt_version: processor.promptVersion }))
    .digest('hex');
}

export class HttpSummaryProcessor implements SummaryProcessor {
  readonly kind = 'http';
  readonly model: string;
  readonly version: string;
  readonly promptVersion: string;
  readonly #endpoint: URL;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;

  constructor(input: { endpoint: URL; apiKey?: string; model?: string; version?: string; promptVersion: string; timeoutMs?: number }) {
    this.#endpoint = input.endpoint;
    this.#apiKey = input.apiKey;
    this.model = input.model ?? 'configured-model';
    this.version = input.version ?? 'configured';
    this.promptVersion = input.promptVersion;
    this.#timeoutMs = input.timeoutMs ?? 10 * 60_000;
  }

  async ready(): Promise<boolean> {
    try {
      return (await fetch(new URL('/healthz', this.#endpoint), {
        headers: this.#headers(),
        signal: AbortSignal.timeout(3_000),
      })).ok;
    } catch {
      return false;
    }
  }

  async summarize(transcript: TranscriptV1): Promise<MeetingSummaryV1> {
    const response = await fetch(new URL('/v1/meeting-summary', this.#endpoint), {
      method: 'POST',
      headers: {
        ...this.#headers(),
        'content-type': 'application/json',
        'idempotency-key': summaryInputKey(transcript, this),
      },
      body: JSON.stringify({
        transcript,
        schema_version: 'demo.meeting-summary.v1',
        prompt_version: this.promptVersion,
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`SUMMARIZER_HTTP_${response.status}`);
    const body = await response.text();
    if (body.length > 5 * 1024 * 1024) throw new Error('SUMMARIZER_RESPONSE_TOO_LARGE');
    return JSON.parse(body) as MeetingSummaryV1;
  }

  #headers(): Record<string, string> {
    return this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
  }
}
