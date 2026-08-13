import { defineCapability } from '../../kernel/capability.js';

export const deliveryManifest = defineCapability({
  id: 'delivery', version: '1.0.0', dependsOn: ['scenario'],
  configKeys: ['notification_enabled', 'courier_base_url'], permissions: ['delivery:read', 'delivery:send', 'delivery:cancel'],
  healthChecks: [], apiContributors: ['actions', 'deliveries'], uiContributors: ['action-stage'], migrations: [],
});
