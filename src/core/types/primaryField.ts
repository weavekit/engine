import type { FieldDefinition } from './fields.js';
import type { ObjectDefinition } from './object.js';

/**
 * Primary-key helpers — the single derivation point for "which field is the
 * primary key". The schema's `primary: true` flag on a field is the only truth
 * source; `ObjectDefinition.primaryKey` was a redundant derived cache and is
 * gone. Every consumer (migration / data-access / gen-types / MCP) reads the
 * primary field through these functions, so a validated object always carries
 * exactly one primary scalar field (new and existing tables alike).
 */

/** primary field of an object — the field carrying `primary: true` */
export function primaryFieldOf(def: ObjectDefinition | undefined): FieldDefinition | undefined {
  return def === undefined ? undefined : def.fields.find((f) => f.primary === true);
}

/** name of the primary field; undefined when the object has no primary declaration */
export function primaryKeyOf(def: ObjectDefinition | undefined): string | undefined {
  return primaryFieldOf(def)?.name;
}
