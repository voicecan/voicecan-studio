import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
const demos = ['studio'];
const importPattern = /(?:from\s+|import\s*\()(['"])([^'"]+)\1/g;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

const failures = [];
for (const name of demos) {
  const demoRoot = resolve(repositoryRoot, name);
  for (const required of ['package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', '.env.example', 'README.md', 'scripts/verify-sdk-artifacts.mjs', 'vendor/sdk-artifacts.sha256']) {
    try { await access(resolve(demoRoot, required)); }
    catch { failures.push(`${name} is missing standalone project file: ${required}`); }
  }
  const manifest = JSON.parse(await readFile(resolve(demoRoot, 'package.json'), 'utf8'));
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (dependency.startsWith('@voicecan-demo/')) failures.push(`${name}/package.json depends on demo package ${dependency}`);
  }
  for (const file of await sourceFiles(resolve(demoRoot, 'src'))) {
    const source = await readFile(file, 'utf8');
    if (/Fixture(?:Transcription|Summary|Meeting)Processor/.test(source)) failures.push(`${relative(repositoryRoot, file)} contains a production Fixture Processor`);
    if (/SlackAdapter|TeamsAdapter|EmailAdapter|SmsAdapter|SmtpTransport/.test(source)) failures.push(`${relative(repositoryRoot, file)} implements a forbidden channel adapter`);
    if (source.includes('device-core/')) failures.push(`${relative(repositoryRoot, file)} references Device Core private source`);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[2];
      if (!specifier?.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      const outside = relative(demoRoot, target).split(sep).includes('..');
      if (outside) failures.push(`${relative(repositoryRoot, file)} imports outside its demo: ${specifier}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('verified the unified Studio source, SDK, channel and private Core boundaries\n');
}
