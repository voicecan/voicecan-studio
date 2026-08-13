import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RecordingMediaDescriptor } from '@voicecan/contracts';
import { StudioService } from './service.js';
import { FfmpegAudioPipeline } from './audio-pipeline.js';
import { LocalAsrProcessor } from './local-asr-processor.js';
import { LocalSummaryProcessor } from './local-summary-processor.js';
import { CourierNotificationProvider } from './notification-provider.js';
import { createStudioServer } from './web.js';
import { VoicecanPlatformAdapter } from './platform/voicecan-adapter.js';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LC3_READINESS_MEDIA: RecordingMediaDescriptor = {
  schema_version: 'recording.media.v1', container: 'lc3', codec: 'lc3', content_type: 'audio/lc3', filename_extension: 'lc3',
  sample_rate_hz: 16_000, channels: 1, bit_depth: null, duration_ms: null, encoding_profile: 'voicecan-lc3-v1', source: 'server_verified',
};

async function modelVersionFromManifest(modelPath: string): Promise<string> {
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(resolve(modelPath, 'voicecan-model-manifest.json'), 'utf8')) as unknown; }
  catch { throw new Error('LOCAL_ASR_MODEL_MANIFEST_MISSING'); }
  if (!manifest || typeof manifest !== 'object') throw new Error('LOCAL_ASR_MODEL_MANIFEST_INVALID');
  const item = manifest as Record<string, unknown>;
  const repository = String(item.repository ?? '');
  const revision = String(item.revision ?? '').toLowerCase();
  if (item.schema_version !== 'voicecan.local-asr-model.v1'
    || !/^[A-Za-z0-9._/-]+$/.test(repository)
    || !/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('LOCAL_ASR_MODEL_MANIFEST_INVALID');
  return `${repository}@${revision}`;
}

async function processorFromEnvironment(): Promise<LocalAsrProcessor> {
  const configuredModelPath = process.env.LOCAL_ASR_MODEL_PATH;
  if (!configuredModelPath) throw new Error('LOCAL_ASR_MODEL_PATH is required');
  const modelPath = resolve(projectRoot, configuredModelPath);
  const modelVersion = await modelVersionFromManifest(modelPath);
  const cpuThreads = Number(process.env.LOCAL_ASR_CPU_THREADS ?? 0);
  const timeoutMs = Number(process.env.LOCAL_ASR_TIMEOUT_MS ?? 2 * 60 * 60_000);
  if (!Number.isSafeInteger(cpuThreads) || cpuThreads < 0) throw new Error('LOCAL_ASR_CPU_THREADS must be a non-negative integer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('LOCAL_ASR_TIMEOUT_MS must be a positive integer');
  return new LocalAsrProcessor({
    python: process.env.LOCAL_ASR_PYTHON || resolve(projectRoot, process.platform === 'win32' ? 'local-asr/.venv/Scripts/python.exe' : 'local-asr/.venv/bin/python'),
    workerPath: process.env.LOCAL_ASR_WORKER || resolve(projectRoot, 'local-asr/worker.py'),
    modelPath,
    modelVersion,
    device: process.env.LOCAL_ASR_DEVICE ?? 'auto',
    computeType: process.env.LOCAL_ASR_COMPUTE_TYPE ?? 'default',
    cpuThreads,
    timeoutMs,
  });
}

async function summaryProcessorFromEnvironment(): Promise<LocalSummaryProcessor> {
  const configuredModelPath = process.env.LOCAL_SUMMARY_MODEL_PATH;
  if (!configuredModelPath) throw new Error('LOCAL_SUMMARY_MODEL_PATH is required');
  const modelPath = resolve(projectRoot, configuredModelPath);
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(resolve(modelPath, 'voicecan-model-manifest.json'), 'utf8')) as unknown; }
  catch { throw new Error('LOCAL_SUMMARY_MODEL_MANIFEST_MISSING'); }
  if (!manifest || typeof manifest !== 'object') throw new Error('LOCAL_SUMMARY_MODEL_MANIFEST_INVALID');
  const item = manifest as Record<string, unknown>;
  const repository = String(item.repository ?? '');
  const revision = String(item.revision ?? '').toLowerCase();
  if (item.schema_version !== 'voicecan.local-summary-model.v1' || !/^[A-Za-z0-9._/-]+$/.test(repository) || !/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('LOCAL_SUMMARY_MODEL_MANIFEST_INVALID');
  const timeoutMs = Number(process.env.LOCAL_SUMMARY_TIMEOUT_MS ?? 2 * 60 * 60_000);
  const gpuMode = process.env.LOCAL_SUMMARY_GPU_MODE ?? 'prefer';
  const gpuLayers = Number(process.env.LOCAL_SUMMARY_GPU_LAYERS ?? -1);
  const contextSize = Number(process.env.LOCAL_SUMMARY_CONTEXT_SIZE ?? 8192);
  const maxTokens = Number(process.env.LOCAL_SUMMARY_MAX_TOKENS ?? 1024);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('LOCAL_SUMMARY_TIMEOUT_MS must be a positive integer');
  if (!['prefer', 'require', 'cpu'].includes(gpuMode)) throw new Error('LOCAL_SUMMARY_GPU_MODE must be prefer, require, or cpu');
  if (!Number.isSafeInteger(gpuLayers) || gpuLayers < -1) throw new Error('LOCAL_SUMMARY_GPU_LAYERS must be -1 or a non-negative integer');
  if (!Number.isSafeInteger(contextSize) || contextSize < 2048) throw new Error('LOCAL_SUMMARY_CONTEXT_SIZE must be an integer of at least 2048');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens >= contextSize) throw new Error('LOCAL_SUMMARY_MAX_TOKENS must be at least 128 and less than LOCAL_SUMMARY_CONTEXT_SIZE');
  return new LocalSummaryProcessor({
    python: process.env.LOCAL_SUMMARY_PYTHON || resolve(projectRoot, process.platform === 'win32' ? 'local-summary/.venv/Scripts/python.exe' : 'local-summary/.venv/bin/python'),
    workerPath: process.env.LOCAL_SUMMARY_WORKER || resolve(projectRoot, 'local-summary/worker.py'), modelPath,
    modelVersion: `${repository}@${revision}`, promptVersion: process.env.SUMMARY_PROMPT_VERSION ?? 'meeting-v2-schema',
    gpuMode: gpuMode as 'prefer' | 'require' | 'cpu', gpuLayers, contextSize, maxTokens, timeoutMs,
  });
}

export async function mainLocal(): Promise<void> {
  const baseUrl = process.env.VOICECAN_SERVER_URL; const applicationToken = process.env.VOICECAN_APPLICATION_TOKEN; const webhookSecret = process.env.VOICECAN_WEBHOOK_SECRET;
  if (!baseUrl || !applicationToken || !webhookSecret) throw new Error('VOICECAN_SERVER_URL, VOICECAN_APPLICATION_TOKEN and VOICECAN_WEBHOOK_SECRET are required');
  console.info('[startup] Local Full configuration loaded; credentials are not logged.');
  const platform = new VoicecanPlatformAdapter({ baseUrl, applicationToken });
  const processor = await processorFromEnvironment();
  const summaryProcessor = await summaryProcessorFromEnvironment();
  const summaryMaxChunkSegments = Number(process.env.LOCAL_SUMMARY_MAX_CHUNK_SEGMENTS ?? 100);
  const summaryMaxChunkCharacters = Number(process.env.LOCAL_SUMMARY_MAX_CHUNK_CHARACTERS ?? 6000);
  const notificationEnabled = process.env.NOTIFICATION_ENABLED === 'true';
  if (notificationEnabled && !process.env.COURIER_API_KEY) throw new Error('COURIER_API_KEY is required when Local Full notification egress is enabled');
  const notificationProvider = notificationEnabled ? new CourierNotificationProvider({
    apiKey: process.env.COURIER_API_KEY!,
    ...(process.env.COURIER_BASE_URL ? { baseURL: process.env.COURIER_BASE_URL } : {}),
  }) : undefined;
  const audioPipeline = new FfmpegAudioPipeline({ ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg', lc3DecoderPath: process.env.LC3_DECODER_PATH ?? 'dlc3' });
  if (process.env.AUDIO_TOOLS_SHA256_MANIFEST) await execFileAsync('sha256sum', ['-c', process.env.AUDIO_TOOLS_SHA256_MANIFEST], { timeout: 10_000 });
  await audioPipeline.assertReady(LC3_READINESS_MEDIA);
  console.info('[startup] FFmpeg and LC3 decoder are ready.');
  const service = new StudioService({
    databasePath: process.env.DEMO_DATABASE_PATH ?? './data/studio/studio.sqlite', workDir: process.env.DEMO_WORK_DIR ?? './work/studio', client: platform, processor, summaryProcessor,
    ...(notificationProvider ? { notificationProvider } : {}), ...(process.env.STUDIO_PUBLIC_URL ? { studioBaseUrl: process.env.STUDIO_PUBLIC_URL } : {}), audioPipeline, maxConcurrentJobs: 1,
    maxChunkSegments: summaryMaxChunkSegments, maxChunkCharacters: summaryMaxChunkCharacters,
  });
  await service.recover();
  console.info('[startup] Local job state recovered.');
  const syncStatus = { running: false, started_at: null as string | null, completed_at: null as string | null, scanned: 0, created: 0, failed: 0, removed: 0, error: null as string | null };
  let syncTask: Promise<typeof syncStatus> | null = null;
  const syncRecordings = (): Promise<typeof syncStatus> => {
    if (syncTask) return syncTask;
    syncTask = (async () => {
      Object.assign(syncStatus, { running: true, started_at: new Date().toISOString(), completed_at: null, scanned: 0, created: 0, failed: 0, removed: 0, error: null });
      console.info('[sync] Reconciling authorized synced recordings with Device Platform...');
      try {
        const known = new Set((await service.list()).map((job) => job.recording_id)); const authorized = new Set<string>();
        for await (const recording of platform.listAuthorized()) {
          syncStatus.scanned += 1; authorized.add(recording.id);
          try {
            await service.acceptRecording(recording, `platform-sync:${recording.id}:${recording.resource_version}`);
            if (!known.has(recording.id)) { known.add(recording.id); syncStatus.created += 1; }
          } catch { syncStatus.failed += 1; }
        }
        syncStatus.removed = await service.reconcileAuthorized(authorized);
      } catch (error) { syncStatus.error = error instanceof Error ? error.message.slice(0, 200) : 'SYNC_FAILED'; }
      syncStatus.running = false; syncStatus.completed_at = new Date().toISOString();
      if (syncStatus.error) console.warn('[sync] Device Platform reconciliation failed; details are available through /api/runtime.');
      else console.info(`[sync] Reconciliation complete: scanned=${syncStatus.scanned}, created=${syncStatus.created}, failed=${syncStatus.failed}, removed=${syncStatus.removed}.`);
      return { ...syncStatus };
    })().finally(() => { syncTask = null; });
    return syncTask;
  };
  await syncRecordings();
  if (syncStatus.error) console.warn('[startup] Device Platform reconciliation failed; the service will continue and expose details through /healthz.');
  else console.info(`[startup] Device Platform reconciliation complete: scanned=${syncStatus.scanned}, created=${syncStatus.created}, removed=${syncStatus.removed}.`);
  const retentionDays = Number(process.env.RESULT_RETENTION_DAYS ?? 30); await service.prune(retentionDays);
  const secrets = [webhookSecret, process.env.VOICECAN_WEBHOOK_SECRET_NEXT].filter((value): value is string => Boolean(value));
  const server = createStudioServer({
    service,
    webhookSecret: secrets,
    deploymentProfile: 'local-full',
    syncRecordings,
    syncStatus: () => ({ ...syncStatus }),
    healthDiagnostics: async () => {
      const diagnostics = processor.diagnostics();
      const summaryDiagnostics = summaryProcessor.diagnostics();
      const storage = await service.storage();
      return {
        ok: diagnostics.ready && summaryDiagnostics.ready && storage.used_ratio < 0.9,
        processing_policy: 'embedded-local-models', storage_policy: 'local-filesystem-only', model_network_egress: false,
        notification_egress: notificationEnabled ? 'courier-only' : 'disabled', processor: diagnostics, summary_processor: summaryDiagnostics,
        job_queue: service.queueDiagnostics(), storage, sync: syncStatus, metrics: await service.metrics(),
      };
    },
  });
  const port = Number(process.env.PORT ?? 8815);
  const host = process.env.HOST ?? '127.0.0.1';
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  server.listen(port, host, () => {
    console.info(`[startup] HTTP server listening on ${host}:${port}.`);
    console.info(`[startup] UI: http://${browserHost}:${port}`);
    console.info(`[startup] Liveness: http://${browserHost}:${port}/livez`);
    console.info(`[startup] Readiness: http://${browserHost}:${port}/healthz`);
  });
  console.info(`[local-asr] Verifying and loading ${processor.diagnostics().model_version}; first startup may take several minutes...`);
  void processor.ready()
    .then(() => { console.info(`[local-asr] Model is ready on ${processor.diagnostics().device ?? 'unknown'}; transcription jobs can now be processed.`); })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      console.error(`[local-asr] Model failed to become ready: ${message}`);
    });
  console.info(`[local-summary] Verifying and loading ${summaryProcessor.diagnostics().model_version}; first startup may take several minutes...`);
  void summaryProcessor.ready()
    .then(() => { console.info(`[local-summary] Model is ready on ${summaryProcessor.diagnostics().device ?? 'unknown'}; summary jobs can now be processed.`); })
    .catch((error: unknown) => { console.error(`[local-summary] Model failed to become ready: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`); });
  const retentionTimer = setInterval(() => { void service.prune(retentionDays); }, 60 * 60_000); retentionTimer.unref();
  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[shutdown] ${signal} received; stopping HTTP server and local model workers...`);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    clearInterval(retentionTimer);
    await Promise.all([processor.close(), summaryProcessor.close(), service.close()]);
    console.info('[shutdown] Voicecan Studio stopped.');
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await mainLocal();

export { processorFromEnvironment, summaryProcessorFromEnvironment };
