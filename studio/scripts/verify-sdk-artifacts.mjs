import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const lock = await readFile(new URL('../vendor/sdk-artifacts.sha256', import.meta.url), 'utf8');
for (const line of lock.split(/\r?\n/).filter(Boolean)) {
  const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
  if (!match) throw new Error(`Invalid SDK artifact lock line: ${line}`);
  const [, expected, relative] = match;
  const content = await readFile(resolve(relative));
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== expected) throw new Error(`SDK artifact checksum mismatch: ${relative}`);
  process.stdout.write(`verified ${relative}\n`);
}


