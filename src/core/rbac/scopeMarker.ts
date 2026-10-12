import type { ObjectDefinition } from '../types/index.js';
import { ROW_SCOPE_MARKERS } from '../types/index.js';

/**
 * The object's row-scope field name, from the generic `scope` marker.
 * `undefined` = the object is not row-scoped.
 */
export function scopeFieldName(def: ObjectDefinition): string | undefined {
  const field = def.fields.find(
    (f) => (f as unknown as Record<string, boolean>)[ROW_SCOPE_MARKERS.SCOPE] === true,
  );
  return field?.name;
}
