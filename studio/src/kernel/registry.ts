import type { CapabilityManifest } from './capability.js';

export class CapabilityRegistry {
  readonly #ordered: CapabilityManifest[];

  constructor(manifests: readonly CapabilityManifest[]) {
    const byId = new Map<string, CapabilityManifest>();
    for (const manifest of manifests) {
      if (byId.has(manifest.id)) throw new Error(`CAPABILITY_DUPLICATE:${manifest.id}`);
      byId.set(manifest.id, manifest);
    }
    const ordered: CapabilityManifest[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`CAPABILITY_CYCLE:${id}`);
      const manifest = byId.get(id);
      if (!manifest) throw new Error(`CAPABILITY_MISSING:${id}`);
      visiting.add(id);
      for (const dependency of manifest.dependsOn) visit(dependency);
      visiting.delete(id); visited.add(id); ordered.push(manifest);
    };
    for (const id of byId.keys()) visit(id);
    this.#ordered = ordered;
  }

  list(): readonly CapabilityManifest[] { return this.#ordered; }

  async doctor(): Promise<Record<string, Array<{ id: string; ok: boolean; detail: string }>>> {
    const output: Record<string, Array<{ id: string; ok: boolean; detail: string }>> = {};
    for (const manifest of this.#ordered) {
      output[manifest.id] = await Promise.all(manifest.healthChecks.map(async (check) => ({ id: check.id, ...await check.run() })));
    }
    return output;
  }
}
