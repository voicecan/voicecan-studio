import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const name = process.argv[process.argv.indexOf('--capability') + 1];
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Use --capability <id>');
const root = resolve(process.cwd(), 'studio/src/capabilities', name);
const manifest = await readFile(resolve(root, 'manifest.ts'), 'utf8');
const layerFiles = [];
for (const layer of ['domain', 'application', 'ports', 'infrastructure', 'presentation']) {
  for (const entry of await readdir(resolve(root, layer), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) layerFiles.push(`studio/src/capabilities/${name}/${layer}/${entry.name}`);
  }
}
const files = ['AGENTS.md', 'studio/AGENTS.md', 'studio/docs/ai-development/START-HERE.md', 'studio/docs/ai-development/CAPABILITY-CATALOG.md', `studio/src/capabilities/${name}/AGENTS.md`, `studio/src/capabilities/${name}/manifest.ts`, ...layerFiles];
console.log(JSON.stringify({ capability: name, manifest: { id: manifest.match(/id:\s*'([^']+)'/)?.[1], version: manifest.match(/version:\s*'([^']+)'/)?.[1] }, safe_context_files: files, excluded: ['.env', 'data/', 'work/', 'models/', '*.sqlite', 'audio', 'transcripts', 'delivery payloads'] }, null, 2));
