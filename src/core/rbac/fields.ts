import type { ObjectDefinition } from '../types/index.js';
import { resolvePermission } from './resolve.js';

/** fields hidden from read output for the given roles (empty = nothing hidden) */
export function excludedFields(def: ObjectDefinition, roles: readonly string[]): string[] {
  return resolvePermission(def, roles)?.exclude ?? [];
}
