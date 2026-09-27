import type { FieldDefinition, ObjectDefinition } from '../types/index.js';
import {
  DEFAULT_FIELD_TYPE_REGISTRY,
  fieldBase,
  primaryFieldsOf,
  type FieldTypeRegistry,
} from '../types/index.js';
import { FIELD_TYPES } from '../types/values.js';

/**
 * SQL-side canonical text of a primary-key value, byte-for-byte equal to the JS
 * `canonicalizePrimaryValue` (see the contract test). Temporal values are
 * formatted with `to_char` (session-independent, microsecond precision) so a
 * record_key computed in SQL equals one computed in JS — required for the
 * record-metadata JOIN and any SQL-side key comparison.
 *
 * `ref` is the (already qualified) column reference, e.g. `t."created_at"`.
 */
export function pkValueTextSql(
  field: FieldDefinition,
  ref: string,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): string {
  const base = fieldBase(registry, field.type);
  switch (base) {
    case FIELD_TYPES.UUID:
      return `lower(${ref}::text)`;
    case FIELD_TYPES.DATE:
      return `to_char(${ref}, 'YYYY-MM-DD')`;
    case FIELD_TYPES.TIME:
      return `to_char(${ref}, 'HH24:MI:SS.US')`;
    case FIELD_TYPES.TIMETZ:
      return `to_char(${ref}, 'HH24:MI:SS.USOF')`;
    case FIELD_TYPES.TIMESTAMP:
      return `to_char(${ref}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
    case FIELD_TYPES.TIMESTAMPTZ:
      return `(to_char(${ref} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z')`;
    default:
      return `${ref}::text`;
  }
}

/**
 * SQL expression producing a row's `record_key` from its primary columns:
 * `concat( octet_length(v1) || ':' || v1, … )` — the length-prefixed encoding
 * (`octet_length` is the UTF-8 byte length, matching `TextEncoder`).
 */
export function recordKeySql(
  def: ObjectDefinition,
  ref: (fieldName: string) => string,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): string {
  const parts = primaryFieldsOf(def).map((field) => {
    const expr = pkValueTextSql(field, ref(field.name), registry);
    return `(octet_length(${expr})::text || ':' || ${expr})`;
  });
  return `concat(${parts.join(', ')})`;
}
