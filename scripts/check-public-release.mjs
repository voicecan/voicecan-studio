import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const root = process.cwd();
const failures = [];
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', '.venv', '__pycache__']);
const sensitiveNames = new Set(['.env', '.env.local']);
const sensitiveExtensions = new Set(['.pem', '.key', '.db', '.sqlite', '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg']);
const textExtensions = new Set(['.md', '.json', '.mjs', '.js', '.ts', '.py', '.sh', '.ps1', '.yml', '.yaml', '.example']);
const retiredName = /\bD[125]\b|Transcription[ -]Studio|Meeting[ -]Assistant|migrate-d2|deprecated-command|legacy[_ -](?:json|import)/i;

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    const name = relative(root, path);
    if (entry.isSymbolicLink()) { failures.push(`symbolic link requires manual review: ${name}`); continue; }
    if (entry.isDirectory()) { walk(path); continue; }
    if (sensitiveNames.has(entry.name) || sensitiveExtensions.has(extname(entry.name).toLowerCase())) failures.push(`sensitive/runtime file must not be published: ${name}`);
    if (name === 'scripts/check-public-release.mjs') continue;
    if (textExtensions.has(extname(entry.name).toLowerCase()) || entry.name.startsWith('Dockerfile')) {
      const match = readFileSync(path, 'utf8').match(retiredName);
      if (match) failures.push(`retired application name remains in ${name}: ${match[0]}`);
    }
  }
}

function tarEntries(archivePath) {
  const tar = gunzipSync(readFileSync(archivePath));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const dataOffset = offset + 512;
    entries.set(name.replace(/^\.\//, ''), tar.subarray(dataOffset, dataOffset + size));
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

walk(root);

if (!existsSync(resolve(root, 'LICENSE'))) failures.push('root LICENSE is missing');
const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const studioPackage = JSON.parse(readFileSync(resolve(root, 'studio/package.json'), 'utf8'));
if (!rootPackage.license) failures.push('root package.json has no SPDX license');
if (!studioPackage.license) failures.push('studio/package.json has no SPDX license');
if (rootPackage.license && studioPackage.license && rootPackage.license !== studioPackage.license) failures.push('package license fields do not match');

for (const archive of readdirSync(resolve(root, 'studio/vendor')).filter((name) => name.endsWith('.tgz'))) {
  const entries = tarEntries(resolve(root, 'studio/vendor', archive));
  const packageEntry = entries.get('package/package.json');
  if (!packageEntry) { failures.push(`${archive} has no package/package.json`); continue; }
  const manifest = JSON.parse(packageEntry.toString('utf8'));
  if (!manifest.license) failures.push(`${archive} has no declared license`);
  if (![...entries.keys()].some((name) => /^package\/(?:LICENSE|COPYING)(?:\.|$)/i.test(name))) failures.push(`${archive} has no packaged license text`);
}

if (failures.length) {
  process.stderr.write(`Public release blocked:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Public release tree checks: OK\n');
}
