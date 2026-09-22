import { DEFAULT_LOCALE } from '../../i18n/index.js';
import type { Locale } from '../../i18n/index.js';
import { SCHEMA_FORMAT_VERSION } from '../schema-version.js';
import type { FieldDefinition, ObjectDefinition } from '../../types/index.js';
import { FIELD_TYPES, READ_SCOPES } from '../../types/values.js';
import { validateField } from './field.js';
import { validateFormulas } from './formulas.js';
import { validateIndexes } from './indexes.js';
import { validateLabels } from './labels.js';
import { validatePermissions } from './permissions.js';
import { fail, isRecord, expectString, SNAKE_CASE, SCALAR_TYPE_VALUES, TITLE_PLACEHOLDER_RE, type Vc } from './primitives.js';

export interface ValidateOptions {
  /** directory name hint; must equal object name when provided */
  nameHint?: string;
  /** message locale; defaults to English */
  locale?: Locale;
  /**
   * field-type whitelist (config `features.fieldTypes`). When provided, a field
   * declaring a type outside the whitelist is rejected (fail-closed). Defaults
   * to all types (gating is opt-in via config).
   */
  allowedFieldTypes?: readonly string[];
}

/**
 * Validate a raw object definition (single object, self-contained checks only).
 * Includes field validation, primary-key rules, titleTemplate placeholder checks
 * and same-object formula validation. Cross-object checks live in buildGraph.
 */
export function validateObject(raw: unknown, options?: ValidateOptions): ObjectDefinition {
  const vc: Vc = { object: '(unknown)', locale: options?.locale ?? DEFAULT_LOCALE };
  if (!isRecord(raw)) fail(vc, 'object.notObject');

  const name = expectString(raw, 'name', vc);
  if (name === undefined) fail(vc, 'object.name.required');
  vc.object = name;
  if (!SNAKE_CASE.test(name)) fail(vc, 'object.name.snake', { name });
  if (options?.nameHint !== undefined && options.nameHint !== name) {
    fail(vc, 'object.nameHint.mismatch', { dir: options.nameHint, name });
  }

  // on-disk format version gate (fail-closed on unknown/future versions)
  let schemaVersion: number | undefined;
  const rawVersion = raw.schemaVersion;
  if (rawVersion !== undefined) {
    if (
      typeof rawVersion !== 'number' ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 1 ||
      rawVersion > SCHEMA_FORMAT_VERSION
    ) {
      fail(vc, 'schema.version.unsupported', {
        version: String(rawVersion),
        supported: SCHEMA_FORMAT_VERSION,
      });
    }
    schemaVersion = rawVersion;
  }

  if (raw.label !== undefined) fail(vc, 'object.label.removed');
  const labels = validateLabels(raw.labels, vc);
  const description = expectString(raw, 'description', vc);

  const rawFields = raw.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) fail(vc, 'object.fields.required');

  const fields = rawFields.map((f) => validateField(f, vc, options?.allowedFieldTypes));
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) fail(vc, 'object.field.duplicate', { field: field.name });
    seen.add(field.name);
  }
  validateFormulas(fields, vc);

  const primaries = fields.filter((f) => f.primary);
  if (primaries.length === 0) fail(vc, 'object.primary.none');
  if (primaries.length > 1) fail(vc, 'object.primary.many');
  const primaryField = primaries[0];
  if (primaryField !== undefined && !SCALAR_TYPE_VALUES.includes(primaryField.type)) {
    fail(vc, 'object.primary.scalarOnly', { type: primaryField.type });
  }
  if (primaryField !== undefined && (primaryField as { formula?: string }).formula !== undefined) {
    fail(vc, 'formula.excludedAttr', { attr: 'primary' });
  }

  const permissions = validatePermissions(raw.permissions, vc, fields);
  const indexes = validateIndexes(raw.indexes, vc);

  // alter: opt-in additive auto-DDL for an existing table (default false)
  if (raw.alter !== undefined && typeof raw.alter !== 'boolean') fail(vc, 'object.alter.boolean');
  const alter = raw.alter === true;

  const titleTemplate = validateTitleTemplate(raw.titleTemplate, fields, vc);

  const ownershipFields = fields.filter((f) => (f as { ownership?: boolean }).ownership === true);
  if (ownershipFields.length > 1) fail(vc, 'field.ownership.many');
  const teamFields = fields.filter((f) => (f as { team?: boolean }).team === true);
  if (teamFields.length > 1) fail(vc, 'field.team.many');

  if (permissions !== undefined) {
    const hasOwnership = ownershipFields.length > 0;
    const hasTeam = teamFields.length > 0;
    for (const [role, p] of Object.entries(permissions)) {
      if (p.read === READ_SCOPES.OWN && !hasOwnership) fail(vc, 'permission.own.ownershipField', { role });
      if (p.read === READ_SCOPES.TEAM && !hasTeam) fail(vc, 'permission.team.teamField', { role });
    }
  }

  return {
    schemaVersion,
    name,
    labels,
    description,
    fields,
    permissions,
    workflow: raw.workflow,
    indexes,
    titleTemplate,
    alter,
  };
}

/** validate titleTemplate placeholders reference existing scalar/seq_no fields */
function validateTitleTemplate(
  raw: unknown,
  fields: FieldDefinition[],
  vc: Vc,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') fail(vc, 'title.notString');
  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  for (const m of raw.matchAll(TITLE_PLACEHOLDER_RE)) {
    const fieldName = m[1] ?? '';
    const field = fieldMap.get(fieldName);
    if (field === undefined) {
      fail(vc, 'title.placeholder.missing', { field: fieldName });
    } else if (
      field.type === FIELD_TYPES.DETAILS ||
      field.type === FIELD_TYPES.MULTI_RELATION
    ) {
      fail(vc, 'title.placeholder.relation', { field: fieldName, type: field.type });
    } else if (field.type === FIELD_TYPES.ENUM && field.multiple === true) {
      fail(vc, 'title.placeholder.multiEnum', { field: fieldName });
    }
  }
  return raw;
}
