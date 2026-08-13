import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const name = process.argv[process.argv.indexOf('--name') + 1];
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Use --name <lower-kebab-case>');
const root = resolve(process.cwd(), 'studio/src/capabilities', name);
for (const layer of ['domain', 'application', 'ports', 'infrastructure', 'presentation', 'test']) await mkdir(resolve(root, layer), { recursive: true });
const symbol = name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
await writeFile(resolve(root, 'manifest.ts'), `import { defineCapability } from '../../kernel/capability.js';\n\nexport const ${symbol}Manifest = defineCapability({\n  id: '${name}', version: '1.0.0', dependsOn: [], configKeys: [], permissions: ['${name}:read'],\n  healthChecks: [], apiContributors: [], uiContributors: [], migrations: [],\n});\n`, { flag: 'wx' });
await writeFile(resolve(root, 'AGENTS.md'), `# ${name}\n\nOwns only the ${name} capability. Follow ../docs/ai-development/START-HERE.md.\n\n- Domain must stay pure.\n- Infrastructure implements local Ports.\n- Add contract, unit and directed integration tests before registration.\n`, { flag: 'wx' });
await writeFile(resolve(root, 'README.md'), `# ${name}\n\nGenerated Capability. Document its user-visible responsibility and public Ports here.\n`, { flag: 'wx' });
console.log(`Generated ${root}. Register its manifest in studio/src/capabilities/index.ts.`);
