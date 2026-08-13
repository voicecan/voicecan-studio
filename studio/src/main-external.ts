import { pathToFileURL } from 'node:url';
import { createStudioServer } from './web.js';
import { StudioRuntime, type StudioConfig } from './runtime.js';

export async function mainExternal(): Promise<void> {
  const baseUrl = process.env.VOICECAN_SERVER_URL;
  const applicationToken = process.env.VOICECAN_APPLICATION_TOKEN;
  const webhookSecret = process.env.VOICECAN_WEBHOOK_SECRET;
  const runtime = new StudioRuntime({ configPath: process.env.DEMO_CONFIG_PATH ?? './data/studio/config.json', databasePath: process.env.DEMO_DATABASE_PATH ?? './data/studio/studio.sqlite', workDir: process.env.DEMO_WORK_DIR ?? './work/studio', ...(process.env.FFMPEG_PATH ? { ffmpegPath: process.env.FFMPEG_PATH } : {}), ...(process.env.LC3_DECODER_PATH ? { lc3DecoderPath: process.env.LC3_DECODER_PATH } : {}) });
  const environmentConfig: StudioConfig | undefined = baseUrl && applicationToken && webhookSecret ? {
    platform_url: baseUrl, application_token: applicationToken, webhook_secret: webhookSecret, webhook_secret_next: process.env.VOICECAN_WEBHOOK_SECRET_NEXT ?? '',
    processor_kind: process.env.PROCESSOR_KIND ?? 'http', processor_endpoint: process.env.PROCESSOR_ENDPOINT ?? 'http://127.0.0.1:9001', processor_api_key: process.env.PROCESSOR_API_KEY ?? '',
    summary_endpoint: process.env.SUMMARY_ENDPOINT ?? 'http://127.0.0.1:9002', summary_api_key: process.env.SUMMARY_API_KEY ?? '',
    summary_model: process.env.SUMMARY_MODEL ?? 'configured-model', summary_prompt_version: process.env.SUMMARY_PROMPT_VERSION ?? 'meeting-v1',
    notification_enabled: process.env.NOTIFICATION_ENABLED === 'true', courier_api_key: process.env.COURIER_API_KEY ?? '',
    courier_base_url: process.env.COURIER_BASE_URL ?? 'https://api.courier.com', studio_public_url: process.env.STUDIO_PUBLIC_URL ?? '',
    retention_days: Number(process.env.RESULT_RETENTION_DAYS ?? 30),
  } : undefined;
  await runtime.initialize(environmentConfig);
  const server = createStudioServer({
    runtime, deploymentProfile: 'external',
    healthDiagnostics: async () => {
      if (!runtime.configured || !runtime.service) return { ok: false, profile: 'external', configured: false, setup_url: '/' };
      const provider = await runtime.service.providerHealth();
      return { ok: true, profile: 'external', configured: true, sync: runtime.syncStatus, notification: provider };
    },
  });
  server.listen(Number(process.env.PORT ?? 8811), process.env.HOST ?? '127.0.0.1');
  const retentionTimer = setInterval(() => { void runtime.prune(); }, 60 * 60_000); retentionTimer.unref();
  const shutdown = async (): Promise<void> => {
    clearInterval(retentionTimer);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await runtime.close();
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await mainExternal();
