import { defineCapability } from '../../kernel/capability.js';

export const summaryManifest = defineCapability({
  id: 'summary', version: '1.0.0', dependsOn: ['recording'],
  configKeys: ['summary_endpoint', 'summary_model', 'summary_prompt_version'], permissions: ['summary:read', 'summary:write', 'summary:confirm'],
  healthChecks: [], apiContributors: ['summary'], uiContributors: ['processor-stage'], migrations: [],
});
