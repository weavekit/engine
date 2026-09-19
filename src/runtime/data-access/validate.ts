import type { Locale, MessageKey, ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import { SchemaError, primaryKeyOf } from '../../core/index.js';
import { DETAILS_COLUMNS, FIELD_TYPES } from '../../core/index.js';
import type { FieldDefinition } from '../../core/index.js';
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

  if (f.type === FIELD_TYPES.STRING || f.type === FIELD_TYPES.TEXT || f.type === FIELD_TYPES.FIRST_NAME || f.type === FIELD_TYPES.LAST_NAME || f.type === FIELD_TYPES.EMAIL || f.type === FIELD_TYPES.PHONE) {
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'string' });
    const str = value as string;
    const s = f as { minLength?: number; maxLength?: number; regex?: string };
    if (s.minLength !== undefined && str.length < s.minLength) fail(vc, 'data.field.minLength', { field: f.name, min: s.minLength });
    if (s.maxLength !== undefined && str.length > s.maxLength) fail(vc, 'data.field.maxLength', { field: f.name, max: s.maxLength });
    if (s.regex !== undefined && !new RegExp(s.regex).test(str)) fail(vc, 'data.field.regex', { field: f.name });
    return;
  }

  if (f.type === FIELD_TYPES.IMAGE) {
    if (f.multiple === true) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        fail(vc, 'data.field.type', { field: f.name, type: 'string array' });
      }
      return;
    }
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'string' });
    return;
  }

  if (f.type === FIELD_TYPES.INTEGER || f.type === FIELD_TYPES.NUMBER || f.type === FIELD_TYPES.CURRENCY) {
    if (typeof value !== 'number' || Number.isNaN(value)) fail(vc, 'data.field.type', { field: f.name, type: 'number' });
    if (f.type === FIELD_TYPES.INTEGER && !Number.isInteger(value)) fail(vc, 'data.field.type', { field: f.name, type: 'integer' });
    if (f.min !== undefined && (value as number) < f.min) fail(vc, 'data.field.min', { field: f.name, min: f.min });
    if (f.max !== undefined && (value as number) > f.max) fail(vc, 'data.field.max', { field: f.name, max: f.max });
    return;
  }

  if (f.type === FIELD_TYPES.BOOLEAN) {
    if (typeof value !== 'boolean') fail(vc, 'data.field.type', { field: f.name, type: 'boolean' });
    return;
  }

  if (f.type === FIELD_TYPES.DATETIME || f.type === FIELD_TYPES.DATE) {
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'date-time' });
    return;
  }

  if (f.type === FIELD_TYPES.JSON) {
    // any JSON value accepted
    return;
  }

  if (f.type === FIELD_TYPES.ENUM) {
    if (f.multiple === true) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        fail(vc, 'data.field.type', { field: f.name, type: 'string array' });
      }
      for (const v of value as string[]) {
        if (!f.options.includes(v)) fail(vc, 'data.field.enum', { field: f.name, options: f.options.join('/') });
      }
      return;
    }
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'enum value' });
    if (!f.options.includes(value as string)) fail(vc, 'data.field.enum', { field: f.name, options: f.options.join('/') });
    return;
  }

  if (f.type === FIELD_TYPES.RELATION || f.type === FIELD_TYPES.PERSON || f.type === FIELD_TYPES.DEPARTMENT) {
    if (typeof value !== 'string') fail(vc, 'data.field.type', { field: f.name, type: 'record id' });
    const target = await targetDef(vc, f.target);
    if (target === undefined) return; // schema-level error already handled elsewhere
    const table = target.name;
    const pk = primaryKeyOf(target)!; // targets always declare a primary (schema-validated)
    const res = await vc.pool.query(`SELECT 1 FROM "${table}" WHERE "${pk}" = $1`, [value]);
    if (res.rowCount === 0) fail(vc, 'data.field.relationMissing', { field: f.name, value });
    return;
  }

  if (f.type === FIELD_TYPES.MULTI_RELATION) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      fail(vc, 'data.field.type', { field: f.name, type: 'record id array' });
    }
    if (value.length === 0) return;
    const target = await targetDef(vc, f.target);
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
  }
}
