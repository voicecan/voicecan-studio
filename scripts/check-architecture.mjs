import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd(), 'studio');
const capabilitiesRoot = resolve(root, 'src/capabilities');
const violations = [];
const portableRelative = (file) => file.slice(root.length + 1).replaceAll('\\', '/');

async function files(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...await files(target));
    else if (entry.name.endsWith('.ts')) output.push(target);
  }
  return output;
}

for (const file of await files(resolve(root, 'src'))) {
  const source = await readFile(file, 'utf8');
  const relative = portableRelative(file);
  if (source.includes("from '@voicecan/server-client'") && !relative.startsWith('src/platform/')) violations.push(`${relative}: Device Platform SDK imports belong only in src/platform`);
  if (relative.startsWith('src/scenarios/') && /from\s+['"](?:node:|@trycourier\/|@voicecan\/server-client)/.test(source)) violations.push(`${relative}: Scenario Pack must remain pure and vendor independent`);
  if (relative.startsWith('src/scenarios/') && /(?:fetch\(|DatabaseSync|createReadStream|writeFile)/.test(source)) violations.push(`${relative}: Scenario Pack performs infrastructure work`);
}

for (const capability of await readdir(capabilitiesRoot, { withFileTypes: true })) {
  if (!capability.isDirectory()) continue;
  const moduleRoot = resolve(capabilitiesRoot, capability.name);
  if (!await access(resolve(moduleRoot, 'manifest.ts')).then(() => true, () => false)) continue;
  const names = new Set(await readdir(moduleRoot));
  for (const required of ['manifest.ts', 'AGENTS.md', 'domain', 'application', 'ports', 'infrastructure', 'presentation']) {
    if (!names.has(required)) violations.push(`${capability.name}: missing ${required}`);
  }
  for (const file of await files(moduleRoot)) {
    const source = await readFile(file, 'utf8');
    const relative = portableRelative(file);
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    if (relative.includes('/domain/') && imports.some((target) => target.startsWith('node:') || target.startsWith('@trycourier/') || /(?:infrastructure|presentation)/.test(target))) violations.push(`${relative}: domain imports outward layer or vendor SDK`);
    if (relative.includes('/application/') && imports.some((target) => /(?:infrastructure|presentation)/.test(target))) violations.push(`${relative}: application imports outward layer`);
    if (imports.some((target) => /capabilities\/[^/]+\/infrastructure/.test(target) || /^\.\.\/\.\.\/[^/]+\/infrastructure/.test(target))) violations.push(`${relative}: imports another capability infrastructure`);
  }
}

const index = await readFile(resolve(capabilitiesRoot, 'index.ts'), 'utf8');
for (const capability of await readdir(capabilitiesRoot, { withFileTypes: true })) {
  if (!capability.isDirectory() || !await access(resolve(capabilitiesRoot, capability.name, 'manifest.ts')).then(() => true, () => false)) continue;
  if (!index.includes(`./${capability.name}/manifest.js`)) violations.push(`${capability.name}: manifest not registered`);
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log('Architecture boundaries: OK');
