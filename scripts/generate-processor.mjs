import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const name = process.argv[process.argv.indexOf('--name') + 1] ?? '';
const kind = process.argv[process.argv.indexOf('--kind') + 1] ?? '';
if (!/^[a-z][a-z0-9-]{1,62}$/.test(name) || !['asr', 'summary'].includes(kind)) throw new Error('Use --name <lower-kebab-case> --kind <asr|summary>.');
const className = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
const root = resolve('studio/src/processors');
const source = kind === 'asr' ? `import type { TranscriptV1 } from '../shared/contracts.js';
import type { TranscriptionInput, TranscriptionProcessor } from '../shared/processor.js';

export class ${className}Processor implements TranscriptionProcessor {
  readonly kind = '${name}';
  readonly version = '1.0.0';
  async ready(): Promise<boolean> { return false; }
  async transcribe(_input: TranscriptionInput): Promise<TranscriptV1> { throw new Error('NOT_IMPLEMENTED'); }
}
` : `import type { MeetingSummaryV1, TranscriptV1 } from '../shared/contracts.js';
import type { SummaryProcessor } from '../summary-processor.js';

export class ${className}Processor implements SummaryProcessor {
  readonly kind = '${name}';
  readonly model = 'configure-me';
  readonly version = '1.0.0';
  readonly promptVersion = 'v1';
  async ready(): Promise<boolean> { return false; }
  async summarize(_transcript: TranscriptV1): Promise<MeetingSummaryV1> { throw new Error('NOT_IMPLEMENTED'); }
}
`;
await mkdir(root, { recursive: true });
const target = resolve(root, `${name}.ts`);
await writeFile(target, source, { flag: 'wx' });
console.log(`Created ${target}. Wire it only in a Composition Root and add contract/failure tests.`);
