import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const value = process.argv[process.argv.indexOf('--name') + 1] ?? '';
if (!/^[a-z][a-z0-9-]{1,62}$/.test(value)) throw new Error('Use --name <lower-kebab-case>.');
const variable = `${value.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase())}Scenario`;
const title = process.argv[process.argv.indexOf('--title') + 1] ?? value.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
const root = resolve('studio/src/scenarios');
const target = resolve(root, `${value}.ts`);
const source = `import type { ScenarioDefinition } from './types.js';

export const ${variable}: ScenarioDefinition = {
  manifest: {
    id: '${value}', version: '1.0.0', title: ${JSON.stringify(title)}, description: 'TODO: describe the user outcome.',
    default_for_attributes: [], processor_stages: ['transcription', 'summarization', '${value}-projection'],
    fields: [{ key: 'result', label: 'Result', type: 'string', required: true }],
    allowed_actions: ['courier.notify'],
  },
  build(input) {
    const segmentRefs = input.transcript.segments.map((segment) => segment.id);
    return {
      schema_version: 'studio.scenario-result.v1', scenario_id: '${value}', scenario_version: '1.0.0',
      recording_id: input.recording.id, title: input.summary.title, overview: input.summary.overview,
      values: { result: input.summary.overview },
      sections: [{ id: 'result', title: 'Result', items: [{ text: input.summary.overview, segment_refs: segmentRefs }] }],
      actions: [], source_transcript_revision: input.transcriptRevision, source_summary_revision: input.summaryRevision,
    };
  },
};
`;
await mkdir(root, { recursive: true });
await writeFile(target, source, { flag: 'wx' });
const builtinsPath = resolve(root, 'builtins.ts');
let builtins = await readFile(builtinsPath, 'utf8');
builtins = `import { ${variable} } from './${value}.js';\n${builtins}`;
builtins = builtins.replace(/export const builtinScenarios = \[([^\]]*)\] as const;/, (_, entries) => `export const builtinScenarios = [${entries.trim()}, ${variable}] as const;`);
await writeFile(builtinsPath, builtins);
console.log(`Created and registered ${target}. Complete fields, projection, tests, and docs before use.`);
