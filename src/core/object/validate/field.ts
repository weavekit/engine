import { parseFormula } from '../../formula/index.js';
import type { BuiltinFieldType, FieldDefinition, FieldType, OnDeleteAction } from '../../types/index.js';
import {
  DEFAULT_FIELD_TYPE_REGISTRY,
  FIELD_TYPE_NAME_PATTERN,
  fieldBase,
  type FieldTypeRegistration,
  type FieldTypeRegistry,
} from '../../types/index.js';
import { FIELD_TYPES, ROW_SCOPE_MARKERS } from '../../types/values.js';
import { validateLabels } from './labels.js';
import {
  fail,
  isRecord,
  expectString,
  expectBoolean,
  expectNumber,
  expectPositiveInt,
  SNAKE_CASE,
  FIELD_TYPE_VALUES,
  ON_DELETE_ACTION_VALUES,
  SEQUENCE_PLACEHOLDER,
  SEQUENCE_TOKEN_VALUES,
  SEQUENCE_CYCLE_VALUES,
  type Vc,
} from './primitives.js';

/** keys always allowed on any field */
const BASE_KEYS = ['name', 'type', 'labels', 'description', 'primary', 'system', 'sensitive'] as const;

/** broad field-type-name shape: built-ins (camelCase) + registered (namespaced) names */
const FIELD_TYPE_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;

/** registered-type name shape (namespace segment required) */
const REGISTERED_FIELD_TYPE_RE = new RegExp(FIELD_TYPE_NAME_PATTERN);

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

/** validation options for a single field (built-in + registered types) */
export interface FieldValidateOptions {
  /** field-type whitelist (config `features.fieldTypes`), fail-closed when provided */
  allowedFieldTypes?: readonly string[];
  /** the effective field-type registry (built-ins + user registrations) */
  fieldTypes?: FieldTypeRegistry;
}

/** validate a single field definition into its typed discriminated-union member */
export function validateField(raw: unknown, vc: Vc, options: FieldValidateOptions = {}): FieldDefinition {
  const allowedFieldTypes = options.allowedFieldTypes;
  const registry = options.fieldTypes ?? DEFAULT_FIELD_TYPE_REGISTRY;
  if (!isRecord(raw)) fail(vc, 'field.notObject');

  const name = expectString(raw, 'name', vc);
  if (name === undefined) fail(vc, 'field.name.required');
  if (!SNAKE_CASE.test(name)) fail(vc, 'field.name.snake', { name });

  const rawType = raw.type;
  if (typeof rawType !== 'string' || !FIELD_TYPE_NAME_RE.test(rawType)) {
    fail(vc, 'field.type.invalid', { type: String(rawType) });
  }

  const isBuiltin = FIELD_TYPE_VALUES.includes(rawType);
  const descriptor = isBuiltin ? undefined : registry.get(rawType);
  if (!isBuiltin) {
    if (!REGISTERED_FIELD_TYPE_RE.test(rawType)) fail(vc, 'field.type.invalid', { type: rawType });
    if (descriptor === undefined) fail(vc, 'field.type.unknown', { type: rawType });
  }
  if (allowedFieldTypes !== undefined && !allowedFieldTypes.includes(rawType)) {
    fail(vc, 'field.type.disabled', { type: rawType });
  }

  // registered (non-builtin) type → generic, descriptor-driven path
  if (!isBuiltin && descriptor !== undefined) {
    return validateRegisteredField(raw, name, rawType, descriptor, vc);
  }

  const type = rawType as BuiltinFieldType;
  checkAllowedKeys(raw, type as FieldType, vc);

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

/**
 * Validate a field whose type is a user/plugin registered type. Attributes are
 * checked against the registration's allow-list (plus the base's conveniences);
 * storage/TS/MCP/OpenAPI behaviour is inherited from `base` at consumption time.
 */
function validateRegisteredField(
  raw: Record<string, unknown>,
  name: string,
  type: string,
  descriptor: FieldTypeRegistration,
  vc: Vc,
): FieldDefinition {
  const base = descriptor.base;
  if (base === undefined) fail(vc, 'field.type.invalid', { type });
  const resolvedBase = fieldBase(DEFAULT_FIELD_TYPE_REGISTRY, base);
  const relationLike = descriptor.relationLike === true || resolvedBase === FIELD_TYPES.RELATION;

  const allowed = new Set<string>([...BASE_KEYS, ...(descriptor.attrs ?? []), 'required', 'unique', 'default']);
  if (relationLike) {
    allowed.add('target');
    allowed.add('onDelete');
  }
  if (resolvedBase === FIELD_TYPES.STRING || resolvedBase === FIELD_TYPES.TEXT) allowed.add('multiple');
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(vc, 'field.attr.notAllowed', { type, attr: key });
  }

  const labels = validateLabels(raw.labels, vc);
  const description = expectString(raw, 'description', vc);
  const primary = expectBoolean(raw, 'primary', vc);
  const system = expectBoolean(raw, 'system', vc);
  const sensitive = expectBoolean(raw, 'sensitive', vc);
  const required = expectBoolean(raw, 'required', vc);
  const unique = expectBoolean(raw, 'unique', vc);
  const multiple = expectBoolean(raw, 'multiple', vc);

  const out: Record<string, unknown> = { name, type, labels, description, primary, system, sensitive, required, unique };
  if (multiple !== undefined) out.multiple = multiple;

  if (relationLike) {
    const target = expectString(raw, 'target', vc);
    if (target === undefined) fail(vc, 'field.relation.target.required');
    if (!SNAKE_CASE.test(target)) fail(vc, 'field.relation.target.snake', { target });
    const onDelete = expectString(raw, 'onDelete', vc) as OnDeleteAction | undefined;
    if (onDelete !== undefined && !ON_DELETE_ACTION_VALUES.includes(onDelete)) {
      fail(vc, 'field.relation.onDelete.invalid', { actions: ON_DELETE_ACTION_VALUES.join('/') });
    }
    out.target = target;
    if (onDelete !== undefined) out.onDelete = onDelete;
  }

  if (raw.default !== undefined) out.default = raw.default;
  return out as unknown as FieldDefinition;
}
