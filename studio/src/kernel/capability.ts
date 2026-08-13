export type HealthCheck = { id: string; run(): Promise<{ ok: boolean; detail: string }> };

export type CapabilityManifest = {
  id: string;
  version: string;
  dependsOn: readonly string[];
  configKeys: readonly string[];
  permissions: readonly string[];
  healthChecks: readonly HealthCheck[];
  apiContributors: readonly string[];
  uiContributors: readonly string[];
  migrations: readonly string[];
};

export function defineCapability(manifest: CapabilityManifest): CapabilityManifest {
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.id)) throw new Error(`CAPABILITY_ID_INVALID:${manifest.id}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`CAPABILITY_VERSION_INVALID:${manifest.id}`);
  if (new Set(manifest.dependsOn).size !== manifest.dependsOn.length || manifest.dependsOn.includes(manifest.id)) throw new Error(`CAPABILITY_DEPENDENCY_INVALID:${manifest.id}`);
  return Object.freeze({ ...manifest });
}
