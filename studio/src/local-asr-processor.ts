import { access, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve, sep } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sanitizeError, validateTranscript, type TranscriptV1, type TranscriptionInput, type TranscriptionProcessor } from './shared/index.js';

type WorkerReady = { type: 'ready'; engine: string; model: string; version: string; device?: string; compute_type?: string };
type WorkerSuccess = { id: string; ok: true; language: string | null; duration_ms: number | null; segments: TranscriptV1['segments'] };
type WorkerFailure = { id: string; ok: false; error: string };
type WorkerMessage = WorkerReady | WorkerSuccess | WorkerFailure;
type PendingRequest = { resolve: (value: WorkerSuccess) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type ModelManifest = { schema_version: string; repository: string; revision: string; files: Array<{ path: string; size: number; sha256: string }> };

function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'VIRTUAL_ENV', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS'] as const;
  return {
    ...Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
  };
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export class LocalAsrProcessor implements TranscriptionProcessor {
  readonly kind = 'local-faster-whisper';
  readonly version: string;
  readonly #python: string;
  readonly #workerPath: string;
  readonly #modelPath: string;
  readonly #device: string;
  readonly #computeType: string;
  readonly #cpuThreads: number;
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
  #actualComputeType: string | null = null;

  constructor(input: { python: string; workerPath: string; modelPath: string; modelVersion: string; device?: string; computeType?: string; cpuThreads?: number; timeoutMs?: number }) {
    this.#python = input.python;
    this.#workerPath = resolve(input.workerPath);
    this.#modelPath = resolve(input.modelPath);
    this.version = input.modelVersion;
    this.#device = input.device ?? 'auto';
    this.#computeType = input.computeType ?? 'default';
    this.#cpuThreads = input.cpuThreads ?? 0;
    this.#timeoutMs = input.timeoutMs ?? 2 * 60 * 60_000;
  }

  diagnostics(): { ready: boolean; active: boolean; queued: number; queue_policy: 'fifo'; model_version: string; requested_device: string; device: string | null; compute_type: string | null; last_error: string | null } {
    return { ready: this.#workerReady, active: this.#active, queued: this.#queued, queue_policy: 'fifo', model_version: this.version, requested_device: this.#device, device: this.#actualDevice, compute_type: this.#actualComputeType, last_error: this.#lastError };
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

  async transcribe(input: TranscriptionInput): Promise<TranscriptV1> {
    this.#queued += 1;
    const task = this.#queue.then(async () => {
      this.#queued -= 1; this.#active = true;
      try { const result = await this.#transcribeNow(input); this.#lastError = null; return result; }
      catch (error) { this.#lastError = sanitizeError(error); throw error; }
      finally { this.#active = false; }
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }

  async #transcribeNow(input: TranscriptionInput): Promise<TranscriptV1> {
    if (!(await this.ready()) || !this.#child) throw new Error('LOCAL_ASR_UNAVAILABLE');
    const id = crypto.randomUUID();
    const result = await new Promise<WorkerSuccess>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#child?.kill('SIGTERM');
        rejectRequest(new Error('LOCAL_ASR_TIMEOUT'));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.#child!.stdin.write(`${JSON.stringify({ id, command: 'transcribe', audio_path: resolve(input.audio_path), language_hint: input.language_hint ?? null })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer); this.#pending.delete(id); rejectRequest(new Error('LOCAL_ASR_WRITE_FAILED'));
      });
    });
    const transcript: TranscriptV1 = {
      schema_version: 'demo.transcript.v1', recording_id: input.recording_id,
      language: result.language, duration_ms: result.duration_ms,
      text: result.segments.map((segment) => segment.text).join(' ').trim(),
      segments: result.segments,
      processor: { provider: 'local-faster-whisper', model: basename(this.#modelPath) || 'local-model', version: this.version },
    };
    validateTranscript(transcript);
    return transcript;
  }

  async #start(): Promise<boolean> {
    await Promise.all([access(this.#workerPath), access(this.#modelPath)]).catch(() => { throw new Error('LOCAL_ASR_FILES_MISSING'); });
    const manifest = JSON.parse(await readFile(resolve(this.#modelPath, 'voicecan-model-manifest.json'), 'utf8')) as ModelManifest;
    if (manifest.schema_version !== 'voicecan.local-asr-model.v1' || `${manifest.repository}@${manifest.revision}` !== this.version || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('LOCAL_ASR_MODEL_VERSION_MISMATCH');
    for (const file of manifest.files) {
      const path = resolve(this.#modelPath, file.path);
      if (!path.startsWith(`${this.#modelPath}${sep}`) || !Number.isSafeInteger(file.size) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('LOCAL_ASR_MODEL_MANIFEST_INVALID');
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size !== file.size || await sha256(path) !== file.sha256) throw new Error('LOCAL_ASR_MODEL_INTEGRITY_FAILED');
    }
    return new Promise<boolean>((resolveReady, rejectReady) => {
      let settled = false;
      const child = spawn(this.#python, [
        '-u', this.#workerPath,
        '--model-path', this.#modelPath,
        '--model-version', this.version,
        '--device', this.#device,
        '--compute-type', this.#computeType,
        '--cpu-threads', String(this.#cpuThreads),
      ], { env: workerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
      this.#child = child;
      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true; child.kill('SIGTERM'); rejectReady(new Error('LOCAL_ASR_STARTUP_TIMEOUT'));
      }, 5 * 60_000);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let message: WorkerMessage;
        try { message = JSON.parse(line) as WorkerMessage; }
        catch { return; }
        if ('type' in message && message.type === 'ready') {
          if (!settled) {
            settled = true; this.#workerReady = true;
            this.#actualDevice = message.device ?? this.#device;
            this.#actualComputeType = message.compute_type ?? this.#computeType;
            clearTimeout(startupTimer); resolveReady(true);
          }
          return;
        }
        if (!('id' in message)) return;
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.#pending.delete(message.id);
        if (message.ok) pending.resolve(message);
        else pending.reject(new Error(`LOCAL_ASR_FAILED:${sanitizeError(message.error)}`));
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000); });
      child.once('error', (error) => {
        if (!settled) { settled = true; clearTimeout(startupTimer); rejectReady(new Error(`LOCAL_ASR_START_FAILED:${sanitizeError(error)}`)); }
      });
      child.once('exit', (code) => {
        clearTimeout(startupTimer);
        const error = new Error(`LOCAL_ASR_EXITED:${code ?? 'signal'}:${sanitizeError(stderr)}`);
        if (!settled) { settled = true; rejectReady(error); }
        if (this.#child !== child) return;
        this.#child = null; this.#workerReady = false; this.#actualDevice = null; this.#actualComputeType = null;
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.#pending.clear();
      });
    });
  }
}
