import type { ScenarioManifest, ScenarioResultV1 } from '../shared/contracts.js';
import { validateScenarioResult } from '../shared/contracts.js';
import { builtinScenarios } from './builtins.js';
import type { ScenarioBuildInput, ScenarioDefinition } from './types.js';

export class ScenarioRegistry {
  readonly #definitions = new Map<string, ScenarioDefinition>();

  constructor(definitions: readonly ScenarioDefinition[] = builtinScenarios) {
    for (const definition of definitions) {
      if (this.#definitions.has(definition.manifest.id)) throw new Error(`SCENARIO_DUPLICATE:${definition.manifest.id}`);
      this.#definitions.set(definition.manifest.id, definition);
    }
  }

  list(): ScenarioManifest[] { return [...this.#definitions.values()].map((definition) => definition.manifest); }

  required(id: string): ScenarioDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) throw Object.assign(new Error('SCENARIO_NOT_FOUND'), { status: 404 });
    return definition;
  }

  defaultForAttribute(attribute: number): ScenarioDefinition {
    return [...this.#definitions.values()].find((definition) => definition.manifest.default_for_attributes.includes(attribute)) ?? this.required('voice-inbox');
  }

  build(id: string, input: ScenarioBuildInput): ScenarioResultV1 {
    const definition = this.required(id);
    const result = definition.build(input);
    validateScenarioResult(result, input.transcript, definition.manifest);
    return result;
  }
}

export const scenarioRegistry = new ScenarioRegistry();
