import type { ObjectDefinition } from '../types/index.js';
import { ROW_SCOPE_MARKERS } from '../types/index.js';

/**
 * The object's row-scope field name, from the generic `scope` marker OR the
 * retained `tenant` alias (they are the same mechanism). `undefined` = the
 * object is not row-scoped.
 */
export function scopeFieldName(def: ObjectDefinition): string | undefined {
  const field = def.fields.find((f) => {
    const raw = f as unknown as Record<string, boolean>;
    return raw[ROW_SCOPE_MARKERS.SCOPE] === true || raw[ROW_SCOPE_MARKERS.TENANT] === true;
  });
  return field?.name;
}

/** which marker an object uses for its row-scope column (for RLS GUC selection) */
export function scopeMarkerOf(def: ObjectDefinition): 'scope' | 'tenant' | undefined {
  const field = def.fields.find((f) => {
    const raw = f as unknown as Record<string, boolean>;
    return raw[ROW_SCOPE_MARKERS.SCOPE] === true || raw[ROW_SCOPE_MARKERS.TENANT] === true;
  });
  if (field === undefined) return undefined;
  const raw = field as unknown as Record<string, boolean>;
  return raw[ROW_SCOPE_MARKERS.SCOPE] === true ? 'scope' : 'tenant';
}
