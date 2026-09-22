import type { Locale, MessageKey, ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import { SchemaError, fieldBase, primaryKeyOf } from '../../core/index.js';
import { DETAILS_COLUMNS, DEFAULT_FIELD_TYPE_REGISTRY, FIELD_TYPES } from '../../core/index.js';
import type { FieldDefinition, RegisteredField } from '../../core/index.js';
import type { Queryable } from './types.js';
import { WRITE_MODES, type WriteMode } from './values.js';

const PARENT_COLUMNS = new Set<string>([
  DETAILS_COLUMNS.PARENT_ID,
  DETAILS_COLUMNS.PARENT_TYPE,
  DETAILS_COLUMNS.PARENT_IDX,
]);

export interface ValidateRecordOptions {
  pool: Queryable;
  registry: ObjectRegistry;
  locale?: Locale;
}

interface Vc {
  object: string;
  locale?: Locale;
  pool: Queryable;
  registry: ObjectRegistry;
}

function fail(vc: Vc, code: MessageKey, params: Record<string, unknown>): never {
  throw new SchemaError(code, { object: vc.object, ...params }, vc.locale);
}

/** engine-managed values users cannot set (system/formula/seq_no) */
function isReadonly(field: FieldDefinition): boolean {
  return field.system === true || field.type === FIELD_TYPES.SEQ_NO || (field as { formula?: string }).formula !== undefined;
}

async function targetDef(
  vc: Vc,
  target: string,
): Promise<ObjectDefinition | undefined> {
  return vc.registry.get(target);
}

async function checkValue(field: FieldDefinition, value: unknown, vc: Vc): Promise<void> {
  const f = field as FieldDefinition;

  // null/undefined = "no value" (a nullable FK with onDelete:set_null, an absent
  // optional field, or a value cleared on update). Type validation only applies
  // to a present value; required-ness is enforced separately by validateRecord.
  if (value === null || value === undefined) return;

  // Resolve the base primitive through the field-type registry so user/plugin
  // registered types inherit the value validation of the primitive they are
  // layered over (a registered type's own `type` is a namespaced name).
  const fieldTypes = vc.registry.fieldTypes ?? DEFAULT_FIELD_TYPE_REGISTRY;
  const base = fieldBase(fieldTypes, f.type);

  // media (image) shares `string` as its base but has array semantics — take it first
  if (f.type === FIELD_TYPES.IMAGE) {
    const im = f as { multiple?: boolean };
    if (im.multiple === true) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        fail(vc, 'data.field.type', { field: f.name, type: 'string array' });
      }
      return;
    }
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'string' });
    return;
  }

  if (base === FIELD_TYPES.STRING || base === FIELD_TYPES.TEXT) {
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'string' });
    const str = value as string;
    const s = f as { minLength?: number; maxLength?: number; regex?: string };
    if (s.minLength !== undefined && str.length < s.minLength) fail(vc, 'data.field.minLength', { field: f.name, min: s.minLength });
    if (s.maxLength !== undefined && str.length > s.maxLength) fail(vc, 'data.field.maxLength', { field: f.name, max: s.maxLength });
    if (s.regex !== undefined && !new RegExp(s.regex).test(str)) fail(vc, 'data.field.regex', { field: f.name });
    return;
  }

  if (base === FIELD_TYPES.INTEGER || base === FIELD_TYPES.NUMBER || base === FIELD_TYPES.CURRENCY) {
    const n = f as { min?: number; max?: number };
    if (typeof value !== 'number' || Number.isNaN(value)) fail(vc, 'data.field.type', { field: f.name, type: 'number' });
    if (base === FIELD_TYPES.INTEGER && !Number.isInteger(value)) fail(vc, 'data.field.type', { field: f.name, type: 'integer' });
    if (n.min !== undefined && (value as number) < n.min) fail(vc, 'data.field.min', { field: f.name, min: n.min });
    if (n.max !== undefined && (value as number) > n.max) fail(vc, 'data.field.max', { field: f.name, max: n.max });
    return;
  }

  if (base === FIELD_TYPES.BOOLEAN) {
    if (typeof value !== 'boolean') fail(vc, 'data.field.type', { field: f.name, type: 'boolean' });
    return;
  }

  if (base === FIELD_TYPES.DATETIME || base === FIELD_TYPES.DATE) {
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'date-time' });
    return;
  }

  if (base === FIELD_TYPES.JSON) {
    // any JSON value accepted
    return;
  }

  if (base === FIELD_TYPES.ENUM) {
    const e = f as { options: string[]; multiple?: boolean };
    if (e.multiple === true) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        fail(vc, 'data.field.type', { field: f.name, type: 'string array' });
      }
      for (const v of value as string[]) {
        if (!e.options.includes(v)) fail(vc, 'data.field.enum', { field: f.name, options: e.options.join('/') });
      }
      return;
    }
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'enum value' });
    if (!e.options.includes(value as string)) fail(vc, 'data.field.enum', { field: f.name, options: e.options.join('/') });
    return;
  }

  if (base === FIELD_TYPES.RELATION) {
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'record id' });
    const target = await targetDef(vc, (f as { target: string }).target);
    if (target === undefined) return; // schema-level error already handled elsewhere
    const table = target.name;
    const pk = primaryKeyOf(target)!; // targets always declare a primary (schema-validated)
    const res = await vc.pool.query(`SELECT 1 FROM "${table}" WHERE "${pk}" = $1`, [value]);
    if (res.rowCount === 0) fail(vc, 'data.field.relationMissing', { field: f.name, value });
    return;
  }

  if (base === FIELD_TYPES.MULTI_RELATION) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      fail(vc, 'data.field.type', { field: f.name, type: 'record id array' });
    }
    if (value.length === 0) return;
    const target = await targetDef(vc, (f as { target: string }).target);
    if (target === undefined) return;
    const table = target.name;
    const pk = primaryKeyOf(target)!; // targets always declare a primary (schema-validated)
    const res = await vc.pool.query(`SELECT 1 FROM "${table}" WHERE "${pk}" = ANY($1)`, [value]);
    if ((res.rowCount ?? 0) !== value.length) {
      fail(vc, 'data.field.multiRelationMissing', { field: f.name });
    }
    return;
  }

  // details / seq_no: handled by details/seqno modules
}

/**
 * Apply a registered type's own `validate` hook and `references` membership
 * check, after the base-primitive validation in `checkValue`. Built-in types
 * carry neither, so this is a no-op for them. `references` runs on the write
 * transaction client (`vc.pool`) when present, keeping the check consistent
 * with the surrounding write.
 */
async function checkRegistered(field: FieldDefinition, value: unknown, vc: Vc): Promise<void> {
  if (value === null || value === undefined) return;
  const descriptor = (vc.registry.fieldTypes ?? DEFAULT_FIELD_TYPE_REGISTRY).get(field.type);
  if (descriptor === undefined) return;

  if (descriptor.validate !== undefined) {
    const detail = descriptor.validate(field as unknown as RegisteredField, value);
    if (detail !== undefined) fail(vc, 'data.field.custom', { field: field.name, detail });
  }

  const ref = descriptor.references;
  if (ref !== undefined) {
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: field.name, type: 'record id' });
    const target = await vc.registry.get(ref.object);
    if (target === undefined) return; // cross-object schema error already raised in buildGraph
    const column = ref.column ?? primaryKeyOf(target)!;
    const res = await vc.pool.query(`SELECT 1 FROM "${target.name}" WHERE "${column}" = $1 LIMIT 1`, [value]);
    if ((res.rowCount ?? 0) === 0) {
      fail(vc, 'data.field.references', { field: field.name, value, ref: ref.object });
    }
  }
}

/**
 * Validate a record before write:
 * - rejects unknown fields and writes to read-only (system/formula/seq_no) fields
 * - enforces required (create), field type, enum/min/max/length/regex
 * - verifies relation / multiRelation targets exist
 * - rejects nested details on update (child rows are managed via the child object CRUD)
 */
export async function validateRecord(
  object: ObjectDefinition,
  data: Record<string, unknown>,
  mode: WriteMode,
  options: ValidateRecordOptions,
): Promise<void> {
  const vc: Vc = { object: object.name, locale: options.locale, pool: options.pool, registry: options.registry };
  const fields = new Map(object.fields.map((f) => [f.name, f]));
  const isDetailsChild = options.registry
    .list()
    .some((o) => o.fields.some((f) => f.type === FIELD_TYPES.DETAILS && f.target === object.name));

  for (const key of Object.keys(data)) {
    if (isDetailsChild && PARENT_COLUMNS.has(key)) continue; // engine-managed columns on child rows
    const field = fields.get(key);
    if (field === undefined) fail(vc, 'data.field.unknown', { field: key });
    if (field?.type === FIELD_TYPES.DETAILS) {
      if (mode === WRITE_MODES.UPDATE) fail(vc, 'data.details.rejected', { field: key });
      continue; // nested details validated by the details module on create
    }
    if (field !== undefined && isReadonly(field)) fail(vc, 'data.field.readonly', { field: key });
  }

  if (isDetailsChild && mode === WRITE_MODES.CREATE) {
    if (data[DETAILS_COLUMNS.PARENT_ID] === undefined || data[DETAILS_COLUMNS.PARENT_TYPE] === undefined) {
      fail(vc, 'data.field.required', {
        field: `${DETAILS_COLUMNS.PARENT_ID}/${DETAILS_COLUMNS.PARENT_TYPE}`,
      });
    }
  }

  if (mode === WRITE_MODES.CREATE) {
    const pk = primaryKeyOf(object);
    for (const field of object.fields) {
      if (field.type === FIELD_TYPES.DETAILS || isReadonly(field)) continue;
      if (field.name === pk) continue; // PK handled below
      if ((field as { required?: boolean }).required === true && data[field.name] === undefined) {
        fail(vc, 'data.field.required', { field: field.name });
      }
    }
    if (pk !== undefined && data[pk] === undefined) {
      fail(vc, 'data.field.required', { field: pk });
    }
  }

  for (const key of Object.keys(data)) {
    const field = fields.get(key);
    if (field === undefined || field.type === FIELD_TYPES.DETAILS) continue;
    await checkValue(field, data[key], vc);
    await checkRegistered(field, data[key], vc);
  }
}
