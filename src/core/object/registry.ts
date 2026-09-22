import { SchemaError } from '../types/errors.js';
import type { ObjectDefinition } from '../types/index.js';
import { DEFAULT_FIELD_TYPE_REGISTRY, type FieldTypeRegistry } from '../types/index.js';
import { buildGraph, RelationGraph, type BuildGraphOptions } from './graph.js';
import { validateObject, type ValidateOptions } from './validate.js';

/**
 * In-memory collection of object definitions keyed by object name.
 *
 * Register validates each object (self-contained checks only — cross-object
 * checks happen in {@link buildGraph}) and rejects duplicates. `buildGraph`
 * then validates relations across the whole set and derives the relation graph.
 *
 * The effective {@link FieldTypeRegistry} (built-ins + user registrations) is
 * carried on the registry so downstream consumers (describe/MCP) can resolve
 * registered types without re-threading options.
 */
export class ObjectRegistry {
  private readonly defs = new Map<string, ObjectDefinition>();
  /** the effective field-type registry this set was validated against */
  readonly fieldTypes: FieldTypeRegistry;

  constructor(options: { fieldTypes?: FieldTypeRegistry } = {}) {
    this.fieldTypes = options.fieldTypes ?? DEFAULT_FIELD_TYPE_REGISTRY;
  }

  /** validate and store one object definition; throws on duplicate name */
  register(input: unknown, options?: ValidateOptions): ObjectDefinition {
    const def = validateObject(input, options);
    if (this.defs.has(def.name)) {
      throw new SchemaError('registry.duplicate', { name: def.name }, options?.locale);
    }
    this.defs.set(def.name, def);
    return def;
  }

  /** look up an object by name */
  get(name: string): ObjectDefinition | undefined {
    return this.defs.get(name);
  }

  /** all registered objects, in registration order */
  list(): ObjectDefinition[] {
    return [...this.defs.values()];
  }

  /** cross-object validation + relation graph derivation over all objects */
  buildGraph(options?: BuildGraphOptions): RelationGraph {
    return buildGraph(this.defs, { ...options, fieldTypes: this.fieldTypes });
  }
}

/** one-off validation of a single object definition (no registry, no graph) */
export function defineObject(input: unknown, options?: ValidateOptions): ObjectDefinition {
  return validateObject(input, options);
}
