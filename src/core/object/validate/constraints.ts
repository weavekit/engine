import type { ConstraintType, ObjectDefinition } from '../../types/index.js';
import { CONSTRAINT_TYPES } from '../../types/values.js';
import { fail, isRecord, type Vc } from './primitives.js';

const CONSTRAINT_TYPE_VALUES: readonly string[] = Object.values(CONSTRAINT_TYPES);

/**
 * Validate the optional object-level `constraints` array: each entry must be a
 * supported kind with a non-empty, duplicate-free `fields` list of existing
 * field names.
 */
export function validateConstraints(
  raw: unknown,
  vc: Vc,
  fields: readonly { name: string }[],
): ObjectDefinition['constraints'] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail(vc, 'object.constraints.notArray');
  const names = new Set(fields.map((f) => f.name));
  return raw.map((entry, i) => {
    if (!isRecord(entry)) fail(vc, 'object.constraints.notObject', { i });
    const type = entry.type;
    if (typeof type !== 'string' || !CONSTRAINT_TYPE_VALUES.includes(type)) {
      fail(vc, 'object.constraints.type.invalid', { i, types: CONSTRAINT_TYPE_VALUES.join('/') });
    }
    const list = entry.fields;
    if (!Array.isArray(list) || list.length === 0 || !list.every((f) => typeof f === 'string')) {
      fail(vc, 'object.constraints.fields.required', { i });
    }
    const seen = new Set<string>();
    for (const f of list as string[]) {
      if (!names.has(f)) fail(vc, 'object.constraints.fields.unknown', { i, field: f });
      if (seen.has(f)) fail(vc, 'object.constraints.fields.duplicate', { i, field: f });
      seen.add(f);
    }
    return { type: type as ConstraintType, fields: list as string[] };
  });
}
