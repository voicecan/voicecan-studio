import { CapabilityRegistry } from '../kernel/registry.js';
import { deliveryManifest } from './delivery/manifest.js';
import { recordingManifest } from './recording/manifest.js';
import { scenarioManifest } from './scenario/manifest.js';
import { summaryManifest } from './summary/manifest.js';

export const capabilityRegistry = new CapabilityRegistry([recordingManifest, summaryManifest, scenarioManifest, deliveryManifest]);
