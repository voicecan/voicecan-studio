import { access, readFile, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { capabilityRegistry } from './capabilities/index.js';

export type DoctorCheck = { id: string; ok: boolean; detail: string; blocking: boolean };
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function command(id: string, executable: string, args: string[], blocking = true): Promise<DoctorCheck> {
  return new Promise((resolveCheck) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-300); });
    child.stderr.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-300); });
    child.once('error', () => resolveCheck({ id, ok: false, detail: `${executable} is unavailable`, blocking }));
    child.once('exit', (code) => resolveCheck({ id, ok: code === 0, detail: code === 0 ? output.trim() || 'available' : `${executable} exited with ${code}`, blocking }));
  });
}

async function manifest(id: string, path: string, schemaVersion: string): Promise<DoctorCheck> {
  try {
    const value = JSON.parse(await readFile(resolve(path, 'voicecan-model-manifest.json'), 'utf8')) as Record<string, unknown>;
    const ok = value.schema_version === schemaVersion && typeof value.revision === 'string' && /^[a-f0-9]{40,64}$/.test(value.revision);
    return { id, ok, detail: ok ? `${String(value.repository)}@${value.revision}` : 'manifest is invalid', blocking: true };
  } catch { return { id, ok: false, detail: 'manifest is missing', blocking: true }; }
}

export async function runDoctor(profile: 'external' | 'local-full'): Promise<{ ok: boolean; profile: string; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  checks.push({ id: 'node', ok: process.versions.node.startsWith('24.'), detail: process.versions.node, blocking: true });
  checks.push(await command('ffmpeg', process.env.FFMPEG_PATH ?? 'ffmpeg', ['-version']));
  checks.push(await command('lc3', process.env.LC3_DECODER_PATH ?? 'dlc3', ['--help']));
  const storage = await statfs(resolve(process.env.DEMO_WORK_DIR ?? './work/studio')).catch(() => null);
  checks.push({ id: 'storage', ok: Boolean(storage && storage.bavail * storage.bsize >= 1024 ** 3), detail: storage ? `${Math.round(storage.bavail * storage.bsize / 1024 ** 3)} GiB free` : 'unavailable', blocking: true });
  if (profile === 'external') {
    checks.push({ id: 'platform-config', ok: Boolean(process.env.VOICECAN_SERVER_URL && process.env.VOICECAN_APPLICATION_TOKEN && process.env.VOICECAN_WEBHOOK_SECRET), detail: 'Device Platform URL/token/webhook secret', blocking: true });
    checks.push({ id: 'asr-endpoint', ok: Boolean(process.env.PROCESSOR_ENDPOINT), detail: process.env.PROCESSOR_ENDPOINT ?? 'missing', blocking: true });
    checks.push({ id: 'summary-endpoint', ok: Boolean(process.env.SUMMARY_ENDPOINT), detail: process.env.SUMMARY_ENDPOINT ?? 'missing', blocking: true });
  } else {
    checks.push(await command('python', process.env.LOCAL_ASR_PYTHON ?? resolve(projectRoot, 'local-asr/.venv/bin/python'), ['--version']));
    checks.push(await manifest('asr-model', process.env.LOCAL_ASR_MODEL_PATH ?? resolve(projectRoot, 'models/faster-whisper-small'), 'voicecan.local-asr-model.v1'));
    checks.push(await manifest('summary-model', process.env.LOCAL_SUMMARY_MODEL_PATH ?? resolve(projectRoot, 'models/qwen3-4b-q4-k-m'), 'voicecan.local-summary-model.v1'));
    checks.push({ id: 'notification-egress', ok: process.env.NOTIFICATION_ENABLED !== 'true' || Boolean(process.env.COURIER_API_KEY), detail: process.env.NOTIFICATION_ENABLED === 'true' ? 'Courier explicitly enabled' : 'disabled by default', blocking: true });
  }
  await access(resolve(projectRoot, 'vendor/sdk-artifacts.sha256')).then(() => checks.push({ id: 'sdk-artifacts', ok: true, detail: 'integrity manifest present', blocking: true }), () => checks.push({ id: 'sdk-artifacts', ok: false, detail: 'integrity manifest missing', blocking: true }));
  const capabilityHealth = await capabilityRegistry.doctor();
  checks.push({
    id: 'capability-registry',
    ok: Object.values(capabilityHealth).flat().every((check) => check.ok),
    detail: capabilityRegistry.list().map((capability) => `${capability.id}@${capability.version}`).join(', '),
    blocking: true,
  });
  return { ok: checks.every((check) => check.ok || !check.blocking), profile, checks };
}

async function main(): Promise<void> {
  const profile = process.argv.includes('--local-full') ? 'local-full' : 'external';
  const result = await runDoctor(profile);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else for (const check of result.checks) console.log(`${check.ok ? 'PASS' : check.blocking ? 'FAIL' : 'WARN'}  ${check.id.padEnd(22)} ${check.detail}`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
