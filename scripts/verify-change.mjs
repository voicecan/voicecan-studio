import { spawnSync } from 'node:child_process';

const name = process.argv[process.argv.indexOf('--capability') + 1];
if (!name) throw new Error('Use --capability <id>');
const commands = [
  ['npm', ['run', 'check:architecture']],
  ['npm', ['run', 'catalog:capabilities', '--', '--check']],
  ['npm', ['run', 'typecheck']],
  ['node', ['--test', 'studio/test/capability-registry.test.js', 'studio/test/unified-service.test.js']],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Directed verification passed for ${name}.`);
