import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const name = process.argv[process.argv.indexOf('--name') + 1] ?? '';
const sdk = process.argv[process.argv.indexOf('--sdk') + 1] ?? '';
if (!/^[a-z][a-z0-9-]{1,62}$/.test(name) || !sdk) throw new Error('Use --name <lower-kebab-case> --sdk <official-package-name>.');
const root = resolve('studio/src/integrations', name);
await mkdir(root, { recursive: true });
await writeFile(resolve(root, 'manifest.ts'), `export const integrationManifest = {
  id: '${name}', version: '1.0.0', official_sdk: ${JSON.stringify(sdk)},
  network_egress: true, secret_names: [], operations: [],
} as const;
`, { flag: 'wx' });
await writeFile(resolve(root, 'README.md'), `# ${name}\n\nOfficial SDK: \`${sdk}\`.\n\nDefine an application-owned Port first, keep SDK types in this directory, pin the dependency exactly, map errors and idempotency, and add a stubbed SDK contract test. Do not implement downstream channel protocols.\n`, { flag: 'wx' });
console.log(`Created ${root}. Install only the official SDK, then implement a typed adapter behind an application Port.`);
