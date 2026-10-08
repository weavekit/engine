import type { Locale } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import type { EnumDefinition } from '../types/index.js';
import { LOCALE_TAG, SNAKE_CASE, isRecord } from './validate/primitives.js';

/**
 * Validation for a named-enum declaration (`enums/<name>.json`). Structural +
 * fail-closed: the name must be a snake_case identifier (it doubles as the
 * PostgreSQL type name and the field `enumType`), `values` must be a non-empty
 * unique string list, and `labels` must key only declared values.
 *
 * Shape errors collapse into `enum.invalid` with a `{detail}` string (mirrors
 * the `fieldtype.invalid` pattern) so the i18n surface stays small.
 */

function invalid(detail: string, locale?: Locale): never {
  throw new SchemaError('enum.invalid', { detail }, locale);
}

/** validate one raw enum declaration into its typed form */
export function validateEnumDefinition(raw: unknown, locale?: Locale): EnumDefinition {
  if (!isRecord(raw)) invalid('a declaration must be a JSON object', locale);

  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) invalid('name is required', locale);
  if (!SNAKE_CASE.test(name)) invalid(`name "${name}" must be snake_case`, locale);

  const rawValues = raw.values;
  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    invalid('values must be a non-empty string array', locale);
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const value of rawValues) {
    if (typeof value !== 'string' || value.length === 0) invalid('values must be non-empty strings', locale);
    if (seen.has(value)) invalid(`duplicate value "${value}"`, locale);
    seen.add(value);
    values.push(value);
  }

  const labels = validateLabels(raw.labels, values, locale);
  return { name, values, ...(labels === undefined ? {} : { labels }) };
}

/** validate the optional `labels` map (locale → value → label), keyed only to declared values */
function validateLabels(
  raw: unknown,
  values: readonly string[],
  locale?: Locale,
): Record<string, Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) invalid('labels must be an object of locale to value map', locale);

  const valueSet = new Set(values);
  const out: Record<string, Record<string, string>> = {};
  for (const [tag, map] of Object.entries(raw)) {
    if (!LOCALE_TAG.test(tag)) invalid(`labels key "${tag}" is not a valid locale tag`, locale);
    if (!isRecord(map)) invalid(`labels for "${tag}" must be an object of value to string`, locale);
    const localized: Record<string, string> = {};
    for (const [value, label] of Object.entries(map)) {
      if (!valueSet.has(value)) invalid(`labels for "${tag}" reference unknown value "${value}"`, locale);
      if (typeof label !== 'string' || label.length === 0) {
        invalid(`label for "${tag}.${value}" must be a non-empty string`, locale);
      }
      localized[value] = label;
    }
    out[tag] = localized;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
