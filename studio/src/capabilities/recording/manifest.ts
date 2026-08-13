import { defineCapability } from '../../kernel/capability.js';

export const recordingManifest = defineCapability({
  id: 'recording', version: '1.0.0', dependsOn: [],
  configKeys: ['platform_url', 'application_token', 'webhook_secret'], permissions: ['recording:read', 'recording:write'],
  healthChecks: [], apiContributors: ['recordings', 'transcript'], uiContributors: ['recording-list', 'transcript-stage'], migrations: [],
});
