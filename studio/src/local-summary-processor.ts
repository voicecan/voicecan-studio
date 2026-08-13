import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sanitizeError, validateMeetingSummary, type MeetingSummaryV1, type TranscriptV1 } from './shared/index.js';
import type { SummaryProcessor } from './summary-processor.js';

type WorkerReady = { type: 'ready'; engine: string; model: string; version: string; device?: string; gpu_layers?: number; gpu_backend_available?: boolean; context_size?: number; max_tokens?: number };
type WorkerSuccess = { id: string; ok: true; summary: MeetingSummaryV1 };
type WorkerFailure = { id: string; ok: false; error: string };
type WorkerMessage = WorkerReady | WorkerSuccess | WorkerFailure;
type PendingRequest = { transcript: TranscriptV1; resolve: (value: MeetingSummaryV1) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type ModelManifest = { schema_version: string; repository: string; revision: string; files: Array<{ path: string; size: number; sha256: string }> };

function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'VIRTUAL_ENV', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS'] as const;
  return {
    ...Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', NO_PROXY: '*', no_proxy: '*',
  };
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export class LocalSummaryProcessor implements SummaryProcessor {
  readonly kind = 'local-llama-cpp';
  readonly model: string;
  readonly version: string;
  readonly promptVersion: string;
  readonly #python: string;
  readonly #workerPath: string;
  readonly #modelPath: string;
  readonly #gpuMode: 'prefer' | 'require' | 'cpu';
  readonly #gpuLayers: number;
  readonly #contextSize: number;
  readonly #maxTokens: number;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #readyPromise: Promise<boolean> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #active = false;
  #workerReady = false;
  #lastError: string | null = null;
  #actualDevice: string | null = null;
  #actualGpuLayers: number | null = null;
  #gpuBackendAvailable: boolean | null = null;
  #actualContextSize: number | null = null;
  #actualMaxTokens: number | null = null;

  constructor(input: { python: string; workerPath: string; modelPath: string; modelVersion: string; promptVersion?: string; gpuMode?: 'prefer' | 'require' | 'cpu'; gpuLayers?: number; contextSize?: number; maxTokens?: number; timeoutMs?: number }) {
    this.#python = input.python;
    this.#workerPath = resolve(input.workerPath);
    this.#modelPath = resolve(input.modelPath);
    this.model = basename(this.#modelPath) || 'local-summary-model';
    this.version = input.modelVersion;
    this.promptVersion = input.promptVersion ?? 'meeting-v1';
    this.#gpuMode = input.gpuMode ?? 'prefer';
    this.#gpuLayers = input.gpuLayers ?? -1;
    this.#contextSize = input.contextSize ?? 8192;
    this.#maxTokens = input.maxTokens ?? 1024;
    this.#timeoutMs = input.timeoutMs ?? 2 * 60 * 60_000;
    if (!Number.isSafeInteger(this.#contextSize) || this.#contextSize < 2048) throw new Error('LOCAL_SUMMARY_CONTEXT_SIZE_INVALID');
    if (!Number.isSafeInteger(this.#maxTokens) || this.#maxTokens < 128 || this.#maxTokens >= this.#contextSize) throw new Error('LOCAL_SUMMARY_MAX_TOKENS_INVALID');
  }

  diagnostics(): { ready: boolean; active: boolean; queued: number; queue_policy: 'fifo'; model_version: string; gpu_mode: 'prefer' | 'require' | 'cpu'; device: string | null; gpu_layers: number | null; gpu_backend_available: boolean | null; context_size: number | null; max_tokens: number | null; last_error: string | null } {
    return { ready: this.#workerReady, active: this.#active, queued: this.#queued, queue_policy: 'fifo', model_version: this.version, gpu_mode: this.#gpuMode, device: this.#actualDevice, gpu_layers: this.#actualGpuLayers, gpu_backend_available: this.#gpuBackendAvailable, context_size: this.#actualContextSize, max_tokens: this.#actualMaxTokens, last_error: this.#lastError };
  }

  async ready(): Promise<boolean> {
    if (this.#readyPromise) return this.#readyPromise;
    if (this.#child && !this.#child.killed) return true;
    this.#readyPromise = this.#start().finally(() => { this.#readyPromise = null; });
    return this.#readyPromise;
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    await new Promise<void>((resolveClose) => {
      child.once('exit', () => resolveClose());
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5_000).unref();
    });
  }

  summarize(transcript: TranscriptV1): Promise<MeetingSummaryV1> {
    this.#queued += 1;
    const task = this.#queue.then(async () => {
      this.#queued -= 1;
      this.#active = true;
      try { const result = await this.#summarizeNow(transcript); this.#lastError = null; return result; }
      catch (error) { this.#lastError = sanitizeError(error); throw error; }
      finally { this.#active = false; }
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }

  async #summarizeNow(transcript: TranscriptV1): Promise<MeetingSummaryV1> {
    if (!(await this.ready()) || !this.#child) throw new Error('LOCAL_SUMMARY_UNAVAILABLE');
    const id = crypto.randomUUID();
    return new Promise<MeetingSummaryV1>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id); this.#child?.kill('SIGTERM'); rejectRequest(new Error('LOCAL_SUMMARY_TIMEOUT'));
      }, this.#timeoutMs);
      this.#pending.set(id, { transcript, resolve: resolveRequest, reject: rejectRequest, timer });
      this.#child!.stdin.write(`${JSON.stringify({ id, command: 'summarize', transcript, prompt_version: this.promptVersion })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer); this.#pending.delete(id); rejectRequest(new Error('LOCAL_SUMMARY_WRITE_FAILED'));
      });
    });
  }

  async #start(): Promise<boolean> {
    await Promise.all([access(this.#workerPath), access(this.#modelPath)]).catch(() => { throw new Error('LOCAL_SUMMARY_FILES_MISSING'); });
    const manifest = JSON.parse(await readFile(resolve(this.#modelPath, 'voicecan-model-manifest.json'), 'utf8')) as ModelManifest;
    if (manifest.schema_version !== 'voicecan.local-summary-model.v1' || `${manifest.repository}@${manifest.revision}` !== this.version || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('LOCAL_SUMMARY_MODEL_VERSION_MISMATCH');
    for (const file of manifest.files) {
      const path = resolve(this.#modelPath, file.path);
      if (!path.startsWith(`${this.#modelPath}${sep}`) || !Number.isSafeInteger(file.size) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('LOCAL_SUMMARY_MODEL_MANIFEST_INVALID');
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size !== file.size || await sha256(path) !== file.sha256) throw new Error('LOCAL_SUMMARY_MODEL_INTEGRITY_FAILED');
    }
    return new Promise<boolean>((resolveReady, rejectReady) => {
      let settled = false;
      const child = spawn(this.#python, [
        '-u', this.#workerPath,
        '--model-path', this.#modelPath,
        '--model-version', this.version,
        '--gpu-mode', this.#gpuMode,
        '--gpu-layers', String(this.#gpuLayers),
        '--context-size', String(this.#contextSize),
        '--max-tokens', String(this.#maxTokens),
      ], { env: workerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
      this.#child = child;
      const startupTimer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGTERM'); rejectReady(new Error('LOCAL_SUMMARY_STARTUP_TIMEOUT')); } }, 5 * 60_000);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let message: WorkerMessage;
        try { message = JSON.parse(line) as WorkerMessage; } catch { return; }
        if ('type' in message && message.type === 'ready') {
          if (!settled) {
            settled = true; this.#workerReady = true;
            this.#actualDevice = message.device ?? null;
            this.#actualGpuLayers = message.gpu_layers ?? null;
            this.#gpuBackendAvailable = message.gpu_backend_available ?? null;
            this.#actualContextSize = message.context_size ?? null;
            this.#actualMaxTokens = message.max_tokens ?? null;
            clearTimeout(startupTimer); resolveReady(true);
          }
          return;
        }
        if (!('id' in message)) return;
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.#pending.delete(message.id);
        if (message.ok) {
          try { validateMeetingSummary(message.summary, pending.transcript); pending.resolve(message.summary); }
          catch (error) { pending.reject(error instanceof Error ? error : new Error('LOCAL_SUMMARY_INVALID')); }
        } else pending.reject(new Error(`LOCAL_SUMMARY_FAILED:${sanitizeError(message.error)}`));
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000); });
      child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(startupTimer); rejectReady(new Error(`LOCAL_SUMMARY_START_FAILED:${sanitizeError(error)}`)); } });
      child.once('exit', (code) => {
        clearTimeout(startupTimer);
        const error = new Error(`LOCAL_SUMMARY_EXITED:${code ?? 'signal'}:${sanitizeError(stderr)}`);
        if (!settled) { settled = true; rejectReady(error); }
        if (this.#child !== child) return;
        this.#child = null; this.#workerReady = false; this.#actualDevice = null; this.#actualGpuLayers = null; this.#gpuBackendAvailable = null; this.#actualContextSize = null; this.#actualMaxTokens = null;
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.#pending.clear();
      });
    });
  }
}
