import { DEFAULT_LOCALE } from '../i18n/index.js';
import type { Locale, MessageKey } from '../i18n/index.js';
import { FormulaOperandError } from '../formula/index.js';
import {
  FORMULA_EXCLUDED_ATTRS,
  FORMULA_TYPES,
  checkOperands,
  detectCycle,
  extractRefs,
  inferType,
  parseFormula,
  typeCompatible,
} from '../formula/index.js';
import type { FormulaType } from '../formula/index.js';
import { SchemaError } from '../types/errors.js';
import { SCHEMA_FORMAT_VERSION } from './schema-version.js';
import type {
  FieldDefinition,
  FieldType,
  ObjectDefinition,
  OnDeleteAction,
  Permissions,
  ReadScope,
} from '../types/index.js';
import {
  FIELD_TYPES,
  INDEX_TYPES,
  ON_DELETE_ACTIONS,
  READ_SCOPES,
  ROW_SCOPE_MARKERS,
  SCALAR_FIELD_TYPES,
  SEQUENCE_CYCLES,
  SEQUENCE_TOKENS,
} from '../types/values.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const FIELD_TYPE_VALUES: readonly string[] = Object.values(FIELD_TYPES);
const ON_DELETE_ACTION_VALUES: readonly string[] = Object.values(ON_DELETE_ACTIONS);
const INDEX_TYPE_VALUES: readonly string[] = Object.values(INDEX_TYPES);
const SCALAR_TYPE_VALUES: readonly string[] = Object.values(SCALAR_FIELD_TYPES);
const SEQUENCE_TOKEN_VALUES: readonly string[] = Object.values(SEQUENCE_TOKENS);
const SEQUENCE_CYCLE_VALUES: readonly string[] = Object.values(SEQUENCE_CYCLES);

const SEQUENCE_PLACEHOLDER = /\{seq(?::\d+)?\}/;

/** placeholders allowed in titleTemplate */
const TITLE_PLACEHOLDER_RE = /\{(\w+)\}/g;

/** keys always allowed on any field */
const BASE_KEYS = ['name', 'type', 'labels', 'description', 'primary', 'system', 'sensitive'] as const;

/** extra keys allowed per field type */
const EXTRA_KEYS: Record<FieldType, readonly string[]> = {
  string: ['minLength', 'maxLength', 'regex', 'required', 'unique', 'default', 'formula', ROW_SCOPE_MARKERS.OWNERSHIP, ROW_SCOPE_MARKERS.TEAM],
  text: ['maxLength', 'required', 'unique', 'default', 'formula'],
  integer: ['min', 'max', 'required', 'unique', 'default', 'formula'],
  number: ['min', 'max', 'precision', 'required', 'unique', 'default', 'formula'],
  currency: ['min', 'max', 'required', 'unique', 'default', 'formula'],
  boolean: ['required', 'unique', 'default', 'formula'],
  datetime: ['required', 'unique', 'default'],
  date: ['required', 'unique', 'default'],
  json: ['required', 'default'],
  enum: ['options', 'multiple', 'required', 'unique', 'default'],
  relation: ['target', 'required', 'unique', 'onDelete'],
  details: ['target'],
  multiRelation: ['target', 'required'],
  seq_no: ['format', 'cycle'],
  firstName: ['minLength', 'maxLength', 'regex', 'required', 'unique', 'default', 'formula'],
  lastName: ['minLength', 'maxLength', 'regex', 'required', 'unique', 'default', 'formula'],
  email: ['minLength', 'maxLength', 'regex', 'required', 'unique', 'default', 'formula'],
  phone: ['minLength', 'maxLength', 'regex', 'required', 'unique', 'default', 'formula'],
  image: ['required', 'unique', 'multiple', 'default'],
  person: ['target', 'required', 'unique', 'onDelete', 'department'],
  department: ['target', 'required', 'unique', 'onDelete'],
};

/** validation context: object being validated + active locale */
interface Vc {
  object: string;
  locale: Locale;
}

function fail(vc: Vc, code: MessageKey, params: Record<string, unknown> = {}): never {
  throw new SchemaError(code, { object: vc.object, ...params }, vc.locale);
}

/** type guard: plain object (not array/null) */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** read an optional string attribute; fails with a localized error if present but not a string */
function expectString(record: Record<string, unknown>, key: string, vc: Vc): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(vc, 'field.attr.string', { attr: key });
  return value;
}

/** read an optional boolean attribute; fails if present but not boolean */
function expectBoolean(record: Record<string, unknown>, key: string, vc: Vc): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(vc, 'field.attr.boolean', { attr: key });
  return value;
}

/** read an optional numeric attribute; fails if present but not a finite number */
function expectNumber(record: Record<string, unknown>, key: string, vc: Vc): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) fail(vc, 'field.attr.number', { attr: key });
  return value;
}

/** read an optional positive integer attribute (used for lengths/precision/padding) */
function expectPositiveInt(record: Record<string, unknown>, key: string, vc: Vc): number | undefined {
  const value = expectNumber(record, key, vc);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) fail(vc, 'field.attr.positiveInt', { attr: key });
  return value;
}

/** validate a labels map: keys must be valid BCP-47 locale tags, values non-empty strings */
function validateLabels(raw: unknown, vc: Vc): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(vc, 'field.labels.notObject');
  const result: Record<string, string> = {};
  for (const [locale, value] of Object.entries(raw)) {
    if (!LOCALE_TAG.test(locale)) fail(vc, 'field.labels.locale.invalid', { locale });
    if (typeof value !== 'string' || value.length === 0) {
      fail(vc, 'field.labels.value.string', { locale });
    }
    result[locale] = value;
  }
  if (Object.keys(result).length === 0) fail(vc, 'field.labels.empty');
  return result;
}

/** reject any attribute not allowed for the given field type (typo protection) */
function checkAllowedKeys(record: Record<string, unknown>, type: FieldType, vc: Vc): void {
  const allowed = new Set<string>([...BASE_KEYS, ...(EXTRA_KEYS[type] ?? [])]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(vc, 'field.attr.notAllowed', { type, attr: key });
  }
}

/** type-check a default value against the field type; options = enum option list */
function validateDefault(value: unknown, type: FieldType, vc: Vc, options?: string[]): void {
  if (value === undefined) return;
  switch (type) {
    case FIELD_TYPES.STRING:
    case FIELD_TYPES.TEXT:
    case FIELD_TYPES.FIRST_NAME:
    case FIELD_TYPES.LAST_NAME:
    case FIELD_TYPES.EMAIL:
    case FIELD_TYPES.PHONE:
      if (typeof value !== 'string') fail(vc, 'field.default.string');
      break;
    case FIELD_TYPES.IMAGE:
      if (typeof value !== 'string' && !Array.isArray(value)) fail(vc, 'field.default.string');
      break;
    case FIELD_TYPES.INTEGER:
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(vc, 'field.default.integer');
      break;
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
      if (typeof value !== 'number') fail(vc, 'field.default.number');
      break;
    case FIELD_TYPES.BOOLEAN:
      if (typeof value !== 'boolean') fail(vc, 'field.default.boolean');
      break;
    case FIELD_TYPES.DATETIME:
      if (typeof value !== 'string') fail(vc, 'field.default.iso');
      break;
    case FIELD_TYPES.DATE:
      if (typeof value !== 'string') fail(vc, 'field.default.string');
      break;
    case FIELD_TYPES.JSON:
      break;
    case FIELD_TYPES.ENUM:
      if (typeof value !== 'string') fail(vc, 'field.default.string');
      if (options !== undefined && !options.includes(value)) fail(vc, 'field.default.inOptions', { value });
      break;
    case FIELD_TYPES.RELATION:
    case FIELD_TYPES.PERSON:
    case FIELD_TYPES.DEPARTMENT:
    case FIELD_TYPES.DETAILS:
    case FIELD_TYPES.MULTI_RELATION:
    case FIELD_TYPES.SEQ_NO:
      fail(vc, 'field.default.notSupported', { type });
  }
}

/** parse a formula expression; fails on syntax errors */
function parseFormulaAttr(raw: Record<string, unknown>, vc: Vc): string | undefined {
  if (raw.formula === undefined) return undefined;
  if (typeof raw.formula !== 'string') fail(vc, 'field.attr.string', { attr: 'formula' });
  try {
    parseFormula(raw.formula);
  } catch (err) {
    fail(vc, 'formula.syntax', { detail: (err as Error).message });
  }
  return raw.formula;
}

/** validate a single field definition into its typed discriminated-union member */
function validateField(raw: unknown, vc: Vc, allowedFieldTypes?: readonly string[]): FieldDefinition {
  if (!isRecord(raw)) fail(vc, 'field.notObject');

  const name = expectString(raw, 'name', vc);
  if (name === undefined) fail(vc, 'field.name.required');
  if (!SNAKE_CASE.test(name)) fail(vc, 'field.name.snake', { name });

  const rawType = raw.type;
  if (typeof rawType !== 'string' || !FIELD_TYPE_VALUES.includes(rawType)) {
    fail(vc, 'field.type.invalid', { type: String(rawType) });
  }
  const type = rawType as FieldType;
  if (allowedFieldTypes !== undefined && !allowedFieldTypes.includes(type)) {
    fail(vc, 'field.type.disabled', { type });
  }

  checkAllowedKeys(raw, type, vc);

  const labels = validateLabels(raw.labels, vc);
  const description = expectString(raw, 'description', vc);
  const primary = expectBoolean(raw, 'primary', vc);
  const system = expectBoolean(raw, 'system', vc);
  const sensitive = expectBoolean(raw, 'sensitive', vc);
  const required = expectBoolean(raw, 'required', vc);
  const unique = expectBoolean(raw, 'unique', vc);

  const base = { name, labels, description, primary, system, sensitive };
  const formula = parseFormulaAttr(raw, vc);

  switch (type) {
    case FIELD_TYPES.STRING: {
      const minLength = expectPositiveInt(raw, 'minLength', vc);
      const maxLength = expectPositiveInt(raw, 'maxLength', vc);
      const regex = expectString(raw, 'regex', vc);
      const ownership = expectBoolean(raw, ROW_SCOPE_MARKERS.OWNERSHIP, vc);
      const team = expectBoolean(raw, ROW_SCOPE_MARKERS.TEAM, vc);
      if (regex !== undefined) {
        try {
          new RegExp(regex);
        } catch {
          fail(vc, 'field.regex.invalid');
        }
      }
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        fail(vc, 'field.minLengthGtMaxLength');
      }
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.STRING,
        formula,
        minLength,
        maxLength,
        regex,
        required,
        unique,
        default: raw.default as string | undefined,
        ownership,
        team,
      };
    }
    case FIELD_TYPES.TEXT: {
      const maxLength = expectPositiveInt(raw, 'maxLength', vc);
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.TEXT,
        formula,
        maxLength,
        required,
        unique,
        default: raw.default as string | undefined,
      };
    }
    case FIELD_TYPES.INTEGER: {
      const min = expectNumber(raw, 'min', vc);
      const max = expectNumber(raw, 'max', vc);
      if (min !== undefined && !Number.isInteger(min)) fail(vc, 'field.min.integer');
      if (max !== undefined && !Number.isInteger(max)) fail(vc, 'field.max.integer');
      if (min !== undefined && max !== undefined && min > max) fail(vc, 'field.minGtMax');
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.INTEGER,
        formula,
        min,
        max,
        required,
        unique,
        default: raw.default as number | undefined,
      };
    }
    case FIELD_TYPES.NUMBER: {
      const min = expectNumber(raw, 'min', vc);
      const max = expectNumber(raw, 'max', vc);
      const precision = expectPositiveInt(raw, 'precision', vc);
      if (min !== undefined && max !== undefined && min > max) fail(vc, 'field.minGtMax');
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.NUMBER,
        formula,
        min,
        max,
        precision,
        required,
        unique,
        default: raw.default as number | undefined,
      };
    }
    case FIELD_TYPES.CURRENCY: {
      const min = expectNumber(raw, 'min', vc);
      const max = expectNumber(raw, 'max', vc);
      if (min !== undefined && max !== undefined && min > max) fail(vc, 'field.minGtMax');
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.CURRENCY,
        formula,
        min,
        max,
        required,
        unique,
        default: raw.default as number | undefined,
      };
    }
    case FIELD_TYPES.BOOLEAN:
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.BOOLEAN,
        formula,
        required,
        unique,
        default: raw.default as boolean | undefined,
      };
    case FIELD_TYPES.DATETIME:
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.DATETIME,
        required,
        unique,
        default: raw.default as string | undefined,
      };
    case FIELD_TYPES.DATE:
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.DATE,
        required,
        unique,
        default: raw.default as string | undefined,
      };
    case FIELD_TYPES.JSON:
      validateDefault(raw.default, type, vc);
      return { ...base, type: FIELD_TYPES.JSON, required, default: raw.default };
    case FIELD_TYPES.ENUM: {
      const options = raw.options;
      if (!Array.isArray(options) || options.length === 0) fail(vc, 'field.enum.options.required');
      if (!options.every((o) => typeof o === 'string')) fail(vc, 'field.enum.options.strings');
      const seen = new Set<string>();
      for (const o of options) {
        if (seen.has(o)) fail(vc, 'field.enum.options.duplicate', { value: o });
        seen.add(o);
      }
      const multiple = expectBoolean(raw, 'multiple', vc);
      if (multiple === true && primary === true) fail(vc, 'field.enum.multiple.primary');
      if (multiple === true && unique === true) fail(vc, 'field.enum.multiple.unique');
      if (multiple === true) {
        if (raw.default !== undefined) {
          if (!Array.isArray(raw.default) || !raw.default.every((v) => typeof v === 'string')) {
            fail(vc, 'field.enum.multiple.default.array');
          }
          for (const v of raw.default) {
            if (!(options as string[]).includes(v)) fail(vc, 'field.enum.multiple.default.inOptions', { value: v });
          }
        }
      } else {
        validateDefault(raw.default, type, vc, options as string[]);
      }
      return {
        ...base,
        type: FIELD_TYPES.ENUM,
        options: options as string[],
        multiple,
        required,
        unique,
        default: multiple === true ? (raw.default as string[] | undefined) : (raw.default as string | undefined),
      };
    }
    case FIELD_TYPES.RELATION: {
      const target = expectString(raw, 'target', vc);
      if (target === undefined) fail(vc, 'field.relation.target.required');
      if (!SNAKE_CASE.test(target)) fail(vc, 'field.relation.target.snake', { target });
      const onDelete = expectString(raw, 'onDelete', vc) as OnDeleteAction | undefined;
      if (onDelete !== undefined && !ON_DELETE_ACTION_VALUES.includes(onDelete)) {
        fail(vc, 'field.relation.onDelete.invalid', { actions: ON_DELETE_ACTION_VALUES.join('/') });
      }
      return { ...base, type: FIELD_TYPES.RELATION, target, required, unique, onDelete };
    }
    case FIELD_TYPES.DETAILS: {
      const target = expectString(raw, 'target', vc);
      if (target === undefined) fail(vc, 'field.details.target.required');
      if (!SNAKE_CASE.test(target)) fail(vc, 'field.details.target.snake', { target });
      return { ...base, type: FIELD_TYPES.DETAILS, target };
    }
    case FIELD_TYPES.MULTI_RELATION: {
      const target = expectString(raw, 'target', vc);
      if (target === undefined) fail(vc, 'field.multiRelation.target.required');
      if (!SNAKE_CASE.test(target)) fail(vc, 'field.multiRelation.target.snake', { target });
      return { ...base, type: FIELD_TYPES.MULTI_RELATION, target, required };
    }
    case FIELD_TYPES.FIRST_NAME:
    case FIELD_TYPES.LAST_NAME:
    case FIELD_TYPES.EMAIL:
    case FIELD_TYPES.PHONE: {
      const minLength = expectPositiveInt(raw, 'minLength', vc);
      const maxLength = expectPositiveInt(raw, 'maxLength', vc);
      const regex = expectString(raw, 'regex', vc);
      if (regex !== undefined) {
        try {
          new RegExp(regex);
        } catch {
          fail(vc, 'field.regex.invalid');
        }
      }
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        fail(vc, 'field.minLengthGtMaxLength');
      }
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type,
        formula,
        minLength,
        maxLength,
        regex,
        required,
        unique,
        default: raw.default as string | undefined,
      };
    }
    case FIELD_TYPES.IMAGE: {
      const multiple = expectBoolean(raw, 'multiple', vc);
      if (multiple === true && primary === true) fail(vc, 'field.enum.multiple.primary');
      if (multiple === true && unique === true) fail(vc, 'field.enum.multiple.unique');
      validateDefault(raw.default, type, vc);
      return {
        ...base,
        type: FIELD_TYPES.IMAGE,
        required,
        unique,
        multiple,
        default: multiple === true ? (raw.default as string[] | undefined) : (raw.default as string | undefined),
      };
    }
    case FIELD_TYPES.PERSON: {
      const target = expectString(raw, 'target', vc);
      if (target === undefined) fail(vc, 'field.relation.target.required');
      if (!SNAKE_CASE.test(target)) fail(vc, 'field.relation.target.snake', { target });
      const onDelete = expectString(raw, 'onDelete', vc) as OnDeleteAction | undefined;
      if (onDelete !== undefined && !ON_DELETE_ACTION_VALUES.includes(onDelete)) {
        fail(vc, 'field.relation.onDelete.invalid', { actions: ON_DELETE_ACTION_VALUES.join('/') });
      }
      const department = expectString(raw, 'department', vc);
      return { ...base, type: FIELD_TYPES.PERSON, target, required, unique, onDelete, department };
    }
    case FIELD_TYPES.DEPARTMENT: {
      const target = expectString(raw, 'target', vc);
      if (target === undefined) fail(vc, 'field.relation.target.required');
      if (!SNAKE_CASE.test(target)) fail(vc, 'field.relation.target.snake', { target });
      const onDelete = expectString(raw, 'onDelete', vc) as OnDeleteAction | undefined;
      if (onDelete !== undefined && !ON_DELETE_ACTION_VALUES.includes(onDelete)) {
        fail(vc, 'field.relation.onDelete.invalid', { actions: ON_DELETE_ACTION_VALUES.join('/') });
      }
      return { ...base, type: FIELD_TYPES.DEPARTMENT, target, required, unique, onDelete };
    }
    case FIELD_TYPES.SEQ_NO: {
      const format = expectString(raw, 'format', vc);
      if (format !== undefined) {
        if (!SEQUENCE_PLACEHOLDER.test(format)) {
          fail(vc, 'field.seqNo.format.seq');
        }
        for (const m of format.matchAll(/\{(\w+)(?::\d+)?\}/g)) {
          const placeholder = m[1] ?? '';
          if (!SEQUENCE_TOKEN_VALUES.includes(placeholder)) {
            fail(vc, 'field.seqNo.format.token', { token: placeholder });
          }
        }
      }
      const cycle = expectString(raw, 'cycle', vc);
      if (cycle !== undefined && !SEQUENCE_CYCLE_VALUES.includes(cycle)) {
        fail(vc, 'field.seqNo.cycle.invalid');
      }
      return { ...base, type: FIELD_TYPES.SEQ_NO, format, cycle: (cycle as 'none' | 'year' | undefined) };
    }
  }
}

/** validate the permissions map: role -> read/create/update/delete/fields.exclude */
const READ_SCOPE_VALUES: readonly string[] = Object.values(READ_SCOPES);

function validatePermissions(raw: unknown, vc: Vc, fields: readonly FieldDefinition[]): Permissions | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(vc, 'permission.notObject');
  const result: Permissions = {};
  for (const [role, value] of Object.entries(raw)) {
    if (!isRecord(value)) fail(vc, 'permission.role.notObject', { role });
    if (value.read !== undefined && !READ_SCOPE_VALUES.includes(value.read as string)) {
      fail(vc, 'permission.read.invalid', { role });
    }
    if (value.create !== undefined && typeof value.create !== 'boolean') fail(vc, 'permission.create.boolean', { role });
    if (value.delete !== undefined && typeof value.delete !== 'boolean') fail(vc, 'permission.delete.boolean', { role });
    if (value.update !== undefined) {
      if (typeof value.update !== 'boolean' && (!Array.isArray(value.update) || !value.update.every((f) => typeof f === 'string'))) {
        fail(vc, 'permission.update.invalid', { role });
      }
    }
    if (value.fields !== undefined) {
      if (!isRecord(value.fields)) fail(vc, 'permission.fields.notObject', { role });
      if (value.fields.exclude !== undefined && (!Array.isArray(value.fields.exclude) || !value.fields.exclude.every((f) => typeof f === 'string'))) {
        fail(vc, 'permission.exclude.strings', { role });
      }
      if (value.fields.create !== undefined) {
        if (!Array.isArray(value.fields.create) || !value.fields.create.every((f) => typeof f === 'string')) {
          fail(vc, 'permission.createFields.strings', { role });
        }
        validateCreateFields(role, value.fields.create, fields, vc);
      }
    }
    result[role] = {
      read: value.read as ReadScope | undefined,
      create: value.create as boolean | undefined,
      update: value.update as boolean | string[] | undefined,
      delete: value.delete as boolean | undefined,
      fields: value.fields as { exclude?: string[]; create?: string[] } | undefined,
    };
  }
  return result;
}

/** a create whitelist must name real fields and cover every required writable field */
function validateCreateFields(role: string, create: string[], fields: readonly FieldDefinition[], vc: Vc): void {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const pk = fields.find((f) => f.primary)?.name;
  for (const name of create) {
    if (!byName.has(name)) fail(vc, 'permission.createFields.unknown', { role, field: name });
  }
  for (const field of fields) {
    if (field.primary === true || field.name === pk) continue;
    const required = 'required' in field && field.required === true;
    const readonly = field.system === true || field.type === FIELD_TYPES.SEQ_NO || (field as { formula?: string }).formula !== undefined;
    if (!required || readonly) continue;
    if (!create.includes(field.name)) {
      fail(vc, 'permission.createFields.missingRequired', { role, field: field.name });
    }
  }
}

/** validate the optional indexes array (btree/gin/gist + non-empty string fields) */
function validateIndexes(raw: unknown, vc: Vc): ObjectDefinition['indexes'] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail(vc, 'index.notArray');
  return raw.map((entry, i) => {
    if (!isRecord(entry)) fail(vc, 'index.notObject', { i });
    const type = entry.type;
    if (typeof type !== 'string' || !INDEX_TYPE_VALUES.includes(type)) {
      fail(vc, 'index.type.invalid', { i, types: INDEX_TYPE_VALUES.join('/') });
    }
    if (!Array.isArray(entry.fields) || entry.fields.length === 0 || !entry.fields.every((f) => typeof f === 'string')) {
      fail(vc, 'index.fields.invalid', { i });
    }
    return { type: type as 'btree' | 'gin' | 'gist', fields: entry.fields as string[] };
  });
}

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

/**
 * Same-object formula validation: exclusions, reference existence, operand/type
 * checks and local formula-formula cycle detection.
 */
function validateFormulas(fields: FieldDefinition[], vc: Vc): void {
  const formulaFields = fields.filter((f) => (f as { formula?: string }).formula !== undefined);
  if (formulaFields.length === 0) return;

  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const fieldTypeOf = (name: string): FormulaType | undefined => {
    const f = fieldByName.get(name);
    if (f === undefined) return undefined;
    switch (f.type) {
      case FIELD_TYPES.STRING:
      case FIELD_TYPES.TEXT:
        return FORMULA_TYPES.STRING;
      case FIELD_TYPES.INTEGER:
      case FIELD_TYPES.NUMBER:
      case FIELD_TYPES.CURRENCY:
        return FORMULA_TYPES.NUMBER;
      case FIELD_TYPES.BOOLEAN:
        return FORMULA_TYPES.BOOLEAN;
      default:
        return undefined;
    }
  };

  for (const field of formulaFields) {
    const formula = (field as { formula: string }).formula;
    const fieldType = field.type;

    for (const attr of Object.values(FORMULA_EXCLUDED_ATTRS)) {
      if ((field as unknown as Record<string, unknown>)[attr] !== undefined) {
        fail(vc, 'formula.excludedAttr', { attr });
      }
    }

    let ast;
    try {
      ast = parseFormula(formula);
    } catch (err) {
      fail(vc, 'formula.syntax', { detail: (err as Error).message });
    }
    const { fields: refs, aggregates } = extractRefs(ast);

    for (const ref of refs) {
      const target = fieldByName.get(ref.parent ?? ref.name);
      if (target === undefined) {
        fail(vc, 'formula.refMissing', { field: ref.parent ?? ref.name });
      }
      const referenced = ref.parent === null ? target : fieldByName.get(ref.parent);
      if (referenced !== undefined && ref.parent === null) {
        if (
          referenced.type === FIELD_TYPES.RELATION ||
          referenced.type === FIELD_TYPES.DETAILS ||
          referenced.type === FIELD_TYPES.MULTI_RELATION ||
          referenced.type === FIELD_TYPES.SEQ_NO
        ) {
          fail(vc, 'formula.refType', { type: referenced.type, field: ref.name });
        }
      } else if (referenced !== undefined && ref.parent !== null) {
        if (referenced.type !== FIELD_TYPES.RELATION && referenced.type !== FIELD_TYPES.DETAILS) {
          fail(vc, 'formula.refType', { type: referenced.type, field: ref.parent });
        }
      }
    }

    for (const agg of aggregates) {
      const parent = fieldByName.get(agg.parent);
      if (parent === undefined) {
        fail(vc, 'formula.refMissing', { field: agg.parent });
      } else if (parent.type !== FIELD_TYPES.DETAILS) {
        fail(vc, 'formula.refType', { type: parent.type, field: agg.parent });
      }
    }

    try {
      checkOperands(ast, fieldTypeOf);
    } catch (err) {
      if (err instanceof FormulaOperandError) {
        fail(vc, 'formula.operandType', { op: err.op, expected: err.expected, got: err.got });
      }
      fail(vc, 'formula.syntax', { detail: (err as Error).message });
    }

    const exprType = inferType(ast, fieldTypeOf);
    if (exprType !== 'any' && !typeCompatible(fieldType, exprType)) {
      fail(vc, 'formula.typeMismatch', { got: exprType, expected: fieldType });
    }
  }

  const nodes = formulaFields.map((f) => f.name);
  const edges: [string, string][] = [];
  for (const field of formulaFields) {
    const formula = (field as { formula: string }).formula;
    let ast;
    try {
      ast = parseFormula(formula);
    } catch {
      continue;
    }
    const { fields: refs } = extractRefs(ast);
    for (const ref of refs) {
      if (ref.parent === null && nodes.includes(ref.name)) {
        edges.push([field.name, ref.name]);
      }
    }
  }
  const cycle = detectCycle(nodes, edges);
  if (cycle) fail(vc, 'formula.cycle', { chain: cycle.join(' -> ') });
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
