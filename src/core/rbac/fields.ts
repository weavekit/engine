import type { ObjectDefinition } from '../types/index.js';
import { resolvePermission } from './resolve.js';
import { resolvePermissionFor, type ObjectLookup } from './details.js';

/** fields hidden from read output for the given roles (empty = nothing hidden) */
export function excludedFields(
  def: ObjectDefinition,
  roles: readonly string[],
  lookup?: ObjectLookup,
): string[] {
  return (lookup === undefined ? resolvePermission(def, roles) : resolvePermissionFor(lookup, def, roles))?.exclude ?? [];
}
