import { Courier } from '@trycourier/courier';
import type { DeliveryIntent, NotificationRecipient, StudioScenarioNotificationV1 } from './shared/index.js';

export type NotificationSubmit = {
  target: DeliveryIntent['target'];
  payload: StudioScenarioNotificationV1;
  idempotencyKey: string;
};

export type NotificationStatus = {
  requestId: string;
  status: string;
  terminal: boolean;
  successful: boolean;
};

export type NotificationHistory = Array<{ type: string; timestamp: string }>;

export type NotificationProvider = {
  readonly kind: 'courier';
  health(): Promise<{ ok: boolean; detail: string }>;
  submit(input: NotificationSubmit): Promise<{ requestId: string }>;
  getStatus(requestId: string): Promise<NotificationStatus>;
  getHistory(requestId: string): Promise<NotificationHistory>;
  cancel(requestId: string): Promise<NotificationStatus>;
};

type CourierClientPort = Pick<Courier, 'send' | 'messages'>;

function courierRecipient(recipient: NotificationRecipient): { user_id: string; data?: Record<string, string> } | { list_id: string } | { audience_id: string } {
  if (recipient.kind === 'user') return { user_id: recipient.user_id, ...(recipient.profile ? { data: recipient.profile } : {}) };
  if (recipient.kind === 'list') return { list_id: recipient.list_id };
  return { audience_id: recipient.audience_id };
}

function mapStatus(requestId: string, status: string): NotificationStatus {
  const successful = ['DELIVERED', 'OPENED', 'CLICKED', 'SENT', 'SIMULATED'].includes(status);
  const terminal = successful || ['CANCELED', 'FILTERED', 'UNDELIVERABLE', 'UNMAPPED', 'UNROUTABLE'].includes(status);
  return { requestId, status, terminal, successful };
}

export class CourierNotificationProvider implements NotificationProvider {
  readonly kind = 'courier' as const;
  readonly #client: CourierClientPort;

  constructor(input: { apiKey?: string; baseURL?: string; timeoutMs?: number; maxRetries?: number; client?: CourierClientPort }) {
    this.#client = input.client ?? new Courier({
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.baseURL ? { baseURL: input.baseURL } : {}),
      timeout: input.timeoutMs ?? 30_000,
      maxRetries: input.maxRetries ?? 2,
    });
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#client.messages.list({ event: 'studio-health-probe' });
      return { ok: true, detail: 'Courier API is reachable and the API key is accepted.' };
    } catch (error) {
      return { ok: false, detail: providerError(error).message };
    }
  }

  async submit(input: NotificationSubmit): Promise<{ requestId: string }> {
    try {
      const response = await this.#client.send.message({
        message: {
          to: courierRecipient(input.target.recipient),
          template: input.target.workflow_id,
          data: input.payload,
          ...(input.target.routing.length > 0 ? { routing: { method: 'single', channels: input.target.routing } } : {}),
          metadata: { event: 'studio.scenario.confirmed', trace_id: input.idempotencyKey },
        },
        'Idempotency-Key': input.idempotencyKey,
      });
      return { requestId: response.requestId };
    } catch (error) {
      throw providerError(error);
    }
  }

  async getStatus(requestId: string): Promise<NotificationStatus> {
    try {
      const response = await this.#client.messages.retrieve(requestId);
      return mapStatus(requestId, response.status);
    } catch (error) {
      throw providerError(error);
    }
  }

  async getHistory(requestId: string): Promise<NotificationHistory> {
    try {
      const response = await this.#client.messages.history(requestId);
      const history: NotificationHistory = [];
      for (const item of response.results) {
        const type = typeof item.type === 'string' ? item.type : 'UNKNOWN';
        const timestamp = typeof item.ts === 'number' || typeof item.ts === 'string' ? new Date(item.ts).toISOString() : new Date(0).toISOString();
        history.push({ type, timestamp });
      }
      return history;
    } catch (error) {
      throw providerError(error);
    }
  }

  async cancel(requestId: string): Promise<NotificationStatus> {
    try {
      const response = await this.#client.messages.cancel(requestId);
      return mapStatus(requestId, response.status);
    } catch (error) {
      throw providerError(error);
    }
  }
}

function providerError(error: unknown): Error & { status?: number; retryable?: boolean } {
  if (!(error instanceof Error)) return Object.assign(new Error('COURIER_REQUEST_FAILED'), { retryable: true });
  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
  return Object.assign(new Error(`COURIER_${status ?? 'NETWORK'}:${error.message}`), { ...(status === undefined ? {} : { status }), retryable });
}
