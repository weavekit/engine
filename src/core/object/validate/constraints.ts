import type { ConstraintType, FieldDefinition, ObjectDefinition } from '../../types/index.js';
import { CONSTRAINT_TYPES, FIELD_TYPES } from '../../types/values.js';
import { fail, isRecord, type Vc } from './primitives.js';

const CONSTRAINT_TYPE_VALUES: readonly string[] = Object.values(CONSTRAINT_TYPES);

/**
 * Validate the optional object-level `constraints` array: each entry must be a
 * supported kind with a non-empty, duplicate-free `fields` list of existing
 * non-`details` field names; the same field set may not be constrained twice.
 */
export function validateConstraints(
  raw: unknown,
  vc: Vc,
  fields: readonly FieldDefinition[],
): ObjectDefinition['constraints'] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail(vc, 'object.constraints.notArray');
  const byName = new Map(fields.map((f) => [f.name, f]));
  const seen = new Set<string>();
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
    const within = new Set<string>();
    for (const f of list as string[]) {
      const field = byName.get(f);
      if (field === undefined) fail(vc, 'object.constraints.fields.unknown', { i, field: f });
      if (field.type === FIELD_TYPES.DETAILS) fail(vc, 'object.constraints.fields.details', { i, field: f });
      if (within.has(f)) fail(vc, 'object.constraints.fields.duplicate', { i, field: f });
      within.add(f);
    }
    const signature = [...list as string[]].sort().join('\u0000');
    if (seen.has(signature)) fail(vc, 'object.constraints.duplicate', { i });
    seen.add(signature);
    return { type: type as ConstraintType, fields: list as string[] };
  });
}
