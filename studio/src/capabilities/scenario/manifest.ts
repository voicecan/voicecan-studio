import { defineCapability } from '../../kernel/capability.js';

export const scenarioManifest = defineCapability({
  id: 'scenario', version: '1.0.0', dependsOn: ['summary'],
  configKeys: [], permissions: ['scenario:read', 'scenario:edit', 'scenario:confirm'],
  healthChecks: [], apiContributors: ['scenarios', 'scenario-revisions'], uiContributors: ['scenario-review-stage'], migrations: [],
});
