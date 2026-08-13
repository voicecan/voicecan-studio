import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { HttpTranscriptionProcessor, sanitizeError } from './shared/index.js';
import { FfmpegAudioPipeline } from './audio-pipeline.js';
import type { AudioPipeline } from './audio-pipeline.js';
import { StudioService } from './service.js';
import { HttpSummaryProcessor } from './summary-processor.js';
import { CourierNotificationProvider } from './notification-provider.js';
import { VoicecanPlatformAdapter } from './platform/voicecan-adapter.js';

export type StudioConfig = {
  platform_url: string;
  application_token: string;
  webhook_secret: string;
  webhook_secret_next: string;
  processor_kind: string;
  processor_endpoint: string;
  processor_api_key: string;
  summary_endpoint: string;
  summary_api_key: string;
  summary_model: string;
  summary_prompt_version: string;
  notification_enabled: boolean;
  courier_api_key: string;
  courier_base_url: string;
  studio_public_url: string;
  retention_days: number;
};

export type PublicStudioConfig = Omit<StudioConfig, 'application_token' | 'webhook_secret' | 'webhook_secret_next' | 'processor_api_key' | 'summary_api_key' | 'courier_api_key'> & {
  application_token_configured: boolean;
  webhook_secret_configured: boolean;
  webhook_secret_next_configured: boolean;
  processor_api_key_configured: boolean;
  summary_api_key_configured: boolean;
  courier_api_key_configured: boolean;
};

export type SyncStatus = {
  running: boolean;
  started_at: string | null;
  completed_at: string | null;
  scanned: number;
  created: number;
  failed: number;
  error: string | null;
};

function validateConfig(value: unknown): StudioConfig {
  if (!value || typeof value !== 'object') throw Object.assign(new Error('CONFIG_INVALID'), { status: 422 });
  const item = value as Record<string, unknown>;
  const platformUrl = String(item.platform_url ?? '').replace(/\/$/, '');
  let parsed: URL;
  try { parsed = new URL(platformUrl); } catch { throw Object.assign(new Error('PLATFORM_URL_INVALID'), { status: 422 }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) throw Object.assign(new Error('PLATFORM_URL_INVALID'), { status: 422 });
  const applicationToken = String(item.application_token ?? '').trim();
  const webhookSecret = String(item.webhook_secret ?? '').trim();
  const webhookSecretNext = String(item.webhook_secret_next ?? '').trim();
  const processorKind = String(item.processor_kind ?? 'http').trim();
  const processorEndpoint = String(item.processor_endpoint ?? 'http://127.0.0.1:9001').trim();
  const summaryEndpoint = String(item.summary_endpoint ?? 'http://127.0.0.1:9002').trim();
  const courierBaseUrl = String(item.courier_base_url ?? 'https://api.courier.com').trim().replace(/\/$/, '');
  if (!applicationToken || !webhookSecret || !processorKind) throw Object.assign(new Error('CONFIG_REQUIRED_FIELDS_MISSING'), { status: 422 });
  if (processorKind !== 'http') throw Object.assign(new Error('PROCESSOR_KIND_INVALID'), { status: 422 });
  try { new URL(processorEndpoint); } catch { throw Object.assign(new Error('PROCESSOR_ENDPOINT_INVALID'), { status: 422 }); }
  try { new URL(summaryEndpoint); } catch { throw Object.assign(new Error('SUMMARY_ENDPOINT_INVALID'), { status: 422 }); }
  let courierUrl: URL;
  try { courierUrl = new URL(courierBaseUrl); } catch { throw Object.assign(new Error('COURIER_BASE_URL_INVALID'), { status: 422 }); }
  const courierLocal = ['127.0.0.1', 'localhost', '::1'].includes(courierUrl.hostname);
  if (courierUrl.username || courierUrl.password || courierUrl.search || courierUrl.hash || courierUrl.pathname !== '/' || courierUrl.protocol !== 'https:' && !(courierLocal && courierUrl.protocol === 'http:')) throw Object.assign(new Error('COURIER_BASE_URL_INVALID'), { status: 422 });
  const notificationEnabled = item.notification_enabled === true || item.notification_enabled === 'true';
  const courierApiKey = String(item.courier_api_key ?? '').trim();
  if (notificationEnabled && !courierApiKey) throw Object.assign(new Error('COURIER_API_KEY_REQUIRED'), { status: 422 });
  const studioPublicUrl = String(item.studio_public_url ?? '').trim().replace(/\/$/, '');
  if (studioPublicUrl) { try { new URL(studioPublicUrl); } catch { throw Object.assign(new Error('STUDIO_PUBLIC_URL_INVALID'), { status: 422 }); } }
  const retentionDays = Number(item.retention_days ?? 30);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw Object.assign(new Error('RETENTION_DAYS_INVALID'), { status: 422 });
  return {
    platform_url: platformUrl, application_token: applicationToken, webhook_secret: webhookSecret, webhook_secret_next: webhookSecretNext,
    processor_kind: processorKind, processor_endpoint: processorEndpoint,
    processor_api_key: String(item.processor_api_key ?? '').trim(),
    summary_endpoint: summaryEndpoint, summary_api_key: String(item.summary_api_key ?? '').trim(),
    summary_model: String(item.summary_model ?? 'configured-model').trim(), summary_prompt_version: String(item.summary_prompt_version ?? 'meeting-v1').trim(),
    notification_enabled: notificationEnabled, courier_api_key: courierApiKey, courier_base_url: courierBaseUrl,
    studio_public_url: studioPublicUrl,
    retention_days: retentionDays,
  };
}

export class StudioRuntime {
  readonly #configPath: string;
  readonly #databasePath: string;
  readonly #workDir: string;
  readonly #ffmpegPath: string;
  readonly #lc3DecoderPath: string;
  readonly #audioPipeline: AudioPipeline | null;
  #config: StudioConfig | null = null;
  #service: StudioService | null = null;
  #client: VoicecanPlatformAdapter | null = null;
  #syncTask: Promise<SyncStatus> | null = null;
  #syncStatus: SyncStatus = { running: false, started_at: null, completed_at: null, scanned: 0, created: 0, failed: 0, error: null };

  constructor(input: { configPath: string; databasePath: string; workDir: string; ffmpegPath?: string; lc3DecoderPath?: string; audioPipeline?: AudioPipeline }) {
    this.#configPath = resolve(input.configPath); this.#databasePath = input.databasePath; this.#workDir = input.workDir;
    this.#ffmpegPath = input.ffmpegPath ?? 'ffmpeg'; this.#lc3DecoderPath = input.lc3DecoderPath ?? 'dlc3';
    this.#audioPipeline = input.audioPipeline ?? null;
  }

  get configured(): boolean { return this.#service !== null; }
  get service(): StudioService | null { return this.#service; }
  get webhookSecrets(): string[] { return this.#config ? [this.#config.webhook_secret, this.#config.webhook_secret_next].filter(Boolean) : []; }
  get syncStatus(): SyncStatus { return { ...this.#syncStatus }; }
  get publicConfig(): PublicStudioConfig | null {
    if (!this.#config) return null;
    return {
      platform_url: this.#config.platform_url, processor_kind: this.#config.processor_kind, processor_endpoint: this.#config.processor_endpoint,
      summary_endpoint: this.#config.summary_endpoint, summary_model: this.#config.summary_model, summary_prompt_version: this.#config.summary_prompt_version,
      notification_enabled: this.#config.notification_enabled, courier_base_url: this.#config.courier_base_url, studio_public_url: this.#config.studio_public_url,
      retention_days: this.#config.retention_days,
      application_token_configured: true, webhook_secret_configured: true,
      webhook_secret_next_configured: Boolean(this.#config.webhook_secret_next),
      processor_api_key_configured: Boolean(this.#config.processor_api_key),
      summary_api_key_configured: Boolean(this.#config.summary_api_key), courier_api_key_configured: Boolean(this.#config.courier_api_key),
    };
  }

  async initialize(environmentConfig?: StudioConfig): Promise<void> {
    let config = environmentConfig;
    if (!config) {
      try { config = validateConfig(JSON.parse(await readFile(this.#configPath, 'utf8'))); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
    }
    const prepared = await this.#prepare(config, false);
    this.#install(config, prepared);
    await this.#service!.recover();
    await this.sync();
    await this.#service!.prune(config.retention_days);
  }

  async configure(value: unknown): Promise<void> {
    const config = validateConfig(value);
    if (this.#syncTask) await this.#syncTask;
    const prepared = await this.#prepare(config, true);
    await mkdir(dirname(this.#configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#configPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#configPath);
    const previous = this.#service;
    await previous?.drain();
    await previous?.close();
    this.#install(config, prepared);
    await this.sync();
    await this.#service!.prune(config.retention_days);
  }

  sync(): Promise<SyncStatus> {
    if (this.#syncTask) return this.#syncTask;
    if (!this.#client || !this.#service) throw Object.assign(new Error('STUDIO_NOT_CONFIGURED'), { status: 503 });
    this.#syncTask = this.#runSync().finally(() => { this.#syncTask = null; });
    return this.#syncTask;
  }

  prune(): Promise<number> {
    if (!this.#service || !this.#config) return Promise.resolve(0);
    return this.#service.prune(this.#config.retention_days);
  }

  async close(): Promise<void> {
    if (this.#syncTask) await this.#syncTask;
    await this.#service?.close();
    this.#service = null;
    this.#client = null;
  }

  async #prepare(config: StudioConfig, verify: boolean): Promise<{ client: VoicecanPlatformAdapter; service: StudioService }> {
    const client = new VoicecanPlatformAdapter({ baseUrl: config.platform_url, applicationToken: config.application_token });
    if (verify) {
      for await (const _recording of client.listAuthorized()) break;
    }
    const processor = new HttpTranscriptionProcessor({ endpoint: new URL(config.processor_endpoint), ...(config.processor_api_key ? { apiKey: config.processor_api_key } : {}), kind: config.processor_kind });
    const summaryProcessor = new HttpSummaryProcessor({
      endpoint: new URL(config.summary_endpoint), ...(config.summary_api_key ? { apiKey: config.summary_api_key } : {}),
      model: config.summary_model, promptVersion: config.summary_prompt_version,
    });
    if (verify && !(await processor.ready())) throw Object.assign(new Error('PROCESSOR_UNAVAILABLE'), { status: 422 });
    if (verify && !(await summaryProcessor.ready())) throw Object.assign(new Error('SUMMARIZER_UNAVAILABLE'), { status: 422 });
    const notificationProvider = config.notification_enabled ? new CourierNotificationProvider({ apiKey: config.courier_api_key, baseURL: config.courier_base_url }) : undefined;
    if (verify && notificationProvider) {
      const health = await notificationProvider.health();
      if (!health.ok) throw Object.assign(new Error(`COURIER_UNAVAILABLE:${health.detail}`), { status: 422 });
    }
    const service = new StudioService({
      databasePath: this.#databasePath, workDir: this.#workDir, client, processor,
      summaryProcessor, ...(notificationProvider ? { notificationProvider } : {}), ...(config.studio_public_url ? { studioBaseUrl: config.studio_public_url } : {}),
      audioPipeline: this.#audioPipeline ?? new FfmpegAudioPipeline({ ffmpegPath: this.#ffmpegPath, lc3DecoderPath: this.#lc3DecoderPath }),
    });
    return { client, service };
  }

  #install(config: StudioConfig, prepared: { client: VoicecanPlatformAdapter; service: StudioService }): void {
    this.#config = config; this.#client = prepared.client; this.#service = prepared.service;
  }

  async #runSync(): Promise<SyncStatus> {
    const client = this.#client!; const service = this.#service!;
    this.#syncStatus = { running: true, started_at: new Date().toISOString(), completed_at: null, scanned: 0, created: 0, failed: 0, error: null };
    try {
      const known = new Set((await service.list()).map((job) => job.recording_id));
      const authorized = new Set<string>();
      for await (const recording of client.listAuthorized()) {
        this.#syncStatus.scanned += 1;
        authorized.add(recording.id);
        try {
          await service.acceptRecording(recording, `platform-sync:${recording.id}:${recording.resource_version}`);
          if (!known.has(recording.id)) { known.add(recording.id); this.#syncStatus.created += 1; }
        } catch { this.#syncStatus.failed += 1; }
      }
      await service.reconcileAuthorized(authorized);
    } catch (error) { this.#syncStatus.error = sanitizeError(error); }
    this.#syncStatus.running = false; this.#syncStatus.completed_at = new Date().toISOString();
    return this.syncStatus;
  }
}
