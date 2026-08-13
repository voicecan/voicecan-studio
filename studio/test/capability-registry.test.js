import assert from 'node:assert/strict';
import test from 'node:test';
import { defineCapability } from '../dist/kernel/capability.js';
import { CapabilityRegistry } from '../dist/kernel/registry.js';
import { capabilityRegistry } from '../dist/capabilities/index.js';

test('Capability Registry resolves dependencies deterministically', () => {
  assert.deepEqual(capabilityRegistry.list().map((item) => item.id), ['recording', 'summary', 'scenario', 'delivery']);
});

test('Capability Registry rejects missing, duplicate and cyclic dependencies', () => {
  const manifest = (id, dependsOn = []) => defineCapability({ id, version: '1.0.0', dependsOn, configKeys: [], permissions: [], healthChecks: [], apiContributors: [], uiContributors: [], migrations: [] });
  assert.throws(() => new CapabilityRegistry([manifest('a', ['missing'])]), /CAPABILITY_MISSING/);
  assert.throws(() => new CapabilityRegistry([manifest('a'), manifest('a')]), /CAPABILITY_DUPLICATE/);
  assert.throws(() => new CapabilityRegistry([manifest('a', ['b']), manifest('b', ['a'])]), /CAPABILITY_CYCLE/);
});
