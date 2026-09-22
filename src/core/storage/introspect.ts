import { DEFAULT_LOCALE } from '../i18n/index.js';
import { validateObject } from '../object/validate.js';
import { FIELD_TYPES, ON_DELETE_ACTIONS } from '../types/values.js';
import type { FieldDefinition, FieldType, ObjectDefinition } from '../types/index.js';
import type { ActualColumn, ActualTable } from './inspect.js';

/** one object produced by reverse modeling (already validated) */
export interface IntrospectedObject {
  /** object name (= table name) */
  name: string;
  /** source table name */
  table: string;
  /** validated object definition (ready to serialize to `objects/<name>/schema.json`) */
  schema: ObjectDefinition;
}

/** a table that was not converted (with a human-readable reason) */
export interface IntrospectSkip {
  table: string;
  reason: string;
}

export interface IntrospectReport {
  objects: IntrospectedObject[];
  skipped: IntrospectSkip[];
  warnings: string[];
  suggestions: string[];
}

export interface IntrospectMapOptions {
  /** only convert these tables (table names) */
  include?: string[];
  /** never convert these tables (table names) */
  exclude?: string[];
}

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/** PostgreSQL `information_schema.columns.data_type` → engine field type (primitives only) */
const PG_TO_FIELD: Record<string, FieldType> = {
  'character varying': FIELD_TYPES.STRING,
  character: FIELD_TYPES.STRING,
  bpchar: FIELD_TYPES.STRING,
  text: FIELD_TYPES.TEXT,
  integer: FIELD_TYPES.INTEGER,
  smallint: FIELD_TYPES.INTEGER,
  bigint: FIELD_TYPES.NUMBER,
  numeric: FIELD_TYPES.NUMBER,
  decimal: FIELD_TYPES.NUMBER,
  real: FIELD_TYPES.NUMBER,
  'double precision': FIELD_TYPES.NUMBER,
  boolean: FIELD_TYPES.BOOLEAN,
  'timestamp with time zone': FIELD_TYPES.DATETIME,
  'timestamp without time zone': FIELD_TYPES.DATETIME,
  date: FIELD_TYPES.DATE,
  json: FIELD_TYPES.JSON,
  jsonb: FIELD_TYPES.JSON,
  uuid: FIELD_TYPES.STRING,
};

/** readable on-delete action (from `inspect.ts`) → engine `ON_DELETE_ACTIONS` (restrict is the default and omitted) */
const FK_ON_DELETE: Record<string, string> = {
  cascade: ON_DELETE_ACTIONS.CASCADE,
  set_null: ON_DELETE_ACTIONS.SET_NULL,
};

interface DefaultResult {
  value?: unknown;
  unsupported?: boolean;
}

/** normalize a PostgreSQL column default into an engine-field default (or mark it unrepresentable) */
function normalizeDefault(raw: string, type: FieldType): DefaultResult {
  const trimmed = raw.trim();
  if (/^now\(\)$/i.test(trimmed) || /^current_timestamp$/i.test(trimmed)) {
    return type === FIELD_TYPES.DATETIME || type === FIELD_TYPES.DATE ? { value: 'now' } : { unsupported: true };
  }
  // any other function call (nextval(...), gen_random_uuid(), ...) is not representable
  if (/\(/.test(trimmed)) return { unsupported: true };

  const withoutCast = trimmed.replace(/::[\s\S]+$/, '').trim();
  const quoted = /^'(.*)'$/.exec(withoutCast);
  const literal = quoted !== null ? quoted[1]!.replace(/''/g, "'") : withoutCast;

  switch (type) {
    case FIELD_TYPES.BOOLEAN:
      if (literal === 'true') return { value: true };
      if (literal === 'false') return { value: false };
      return { unsupported: true };
    case FIELD_TYPES.INTEGER:
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY: {
      const n = Number(literal);
      return Number.isFinite(n) ? { value: n } : { unsupported: true };
    }
    case FIELD_TYPES.DATETIME:
    case FIELD_TYPES.DATE:
    case FIELD_TYPES.STRING:
    case FIELD_TYPES.TEXT:
    case FIELD_TYPES.ENUM:
    case FIELD_TYPES.FIRST_NAME:
    case FIELD_TYPES.LAST_NAME:
    case FIELD_TYPES.EMAIL:
    case FIELD_TYPES.PHONE:
    case FIELD_TYPES.IMAGE:
      return { value: literal };
    default:
      return { unsupported: true };
  }
}

/** map one PostgreSQL column to an engine field (undefined = unsupported; a warning is pushed) */
function mapColumn(col: ActualColumn, table: ActualTable, warnings: string[]): FieldDefinition | undefined {
  const base: Record<string, unknown> = { name: col.name };
  if (col.comment !== undefined) base.labels = { [DEFAULT_LOCALE]: col.comment };
  const required = col.isNullable ? undefined : true;
  const unique = table.uniqueColumns?.includes(col.name) === true && !table.pk.includes(col.name);

  const fk = table.fks.find((f) => f.column === col.name);
  if (fk !== undefined) {
    if (!SNAKE_CASE.test(fk.refTable)) {
      warnings.push(`column "${table.name}.${col.name}": FK target table "${fk.refTable}" is not a valid object name — skipped`);
      return undefined;
    }
    const field: Record<string, unknown> = { ...base, type: FIELD_TYPES.RELATION, target: fk.refTable };
    if (required === true) field.required = true;
    if (unique) field.unique = true;
    const onDelete = fk.onDelete === undefined ? undefined : FK_ON_DELETE[fk.onDelete];
    if (onDelete !== undefined) field.onDelete = onDelete;
    return field as unknown as FieldDefinition;
  }

  // user-defined enum (labels come from the detail inspect)
  if (col.enumLabels !== undefined && col.enumLabels.length > 0) {
    const field: Record<string, unknown> = { ...base, type: FIELD_TYPES.ENUM, options: [...col.enumLabels] };
    if (required === true) field.required = true;
    if (unique) field.unique = true;
    if (col.columnDefault !== null) {
      const def = normalizeDefault(col.columnDefault, FIELD_TYPES.ENUM);
      if (def.value !== undefined) field.default = def.value;
      else if (def.unsupported === true) warnings.push(`column "${table.name}.${col.name}": default "${col.columnDefault}" not representable — omitted`);
    }
    return field as unknown as FieldDefinition;
  }

  if (col.udtName?.startsWith('_') === true || col.dataType === 'ARRAY') {
    warnings.push(`column "${table.name}.${col.name}": array type not supported — skipped`);
    return undefined;
  }

  const fieldType = PG_TO_FIELD[col.dataType];
  if (fieldType === undefined) {
    warnings.push(`column "${table.name}.${col.name}": type "${col.dataType}" not supported — skipped`);
    return undefined;
  }
  if (col.dataType === 'bigint') warnings.push(`column "${table.name}.${col.name}": bigint mapped to number`);
  if (col.dataType === 'uuid') warnings.push(`column "${table.name}.${col.name}": uuid mapped to string (no engine uuid type)`);

  const field: Record<string, unknown> = { ...base, type: fieldType };
  if (required === true) field.required = true;
  if (unique) field.unique = true;
  if (fieldType === FIELD_TYPES.NUMBER && col.numericPrecision !== undefined && col.numericPrecision !== null) {
    field.precision = col.numericPrecision;
  }
  if (col.columnDefault !== null) {
    const def = normalizeDefault(col.columnDefault, fieldType);
    if (def.value !== undefined) field.default = def.value;
    else if (def.unsupported === true) warnings.push(`column "${table.name}.${col.name}": default "${col.columnDefault}" not representable — omitted`);
  }
  return field as unknown as FieldDefinition;
}

/**
 * Reverse-model live PostgreSQL tables into engine object drafts. Pure (no I/O):
 * feed it an `inspectSchema(pool, { detail: true })` map. Objects that fail
 * validation (composite/missing PK, non-snake_case names, unsupported PK type)
 * are reported in `skipped`, never silently dropped.
 */
export function mapToSchema(tables: Map<string, ActualTable>, options: IntrospectMapOptions = {}): IntrospectReport {
  const include = options.include === undefined ? undefined : new Set(options.include);
  const exclude = options.exclude === undefined ? undefined : new Set(options.exclude);
  const objects: IntrospectedObject[] = [];
  const skipped: IntrospectSkip[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  for (const name of [...tables.keys()].sort()) {
    if (include !== undefined && !include.has(name)) continue;
    if (exclude?.has(name) === true) continue;
    const table = tables.get(name);
    if (table === undefined) continue;

    if (!SNAKE_CASE.test(name)) {
      skipped.push({ table: name, reason: 'table name is not snake_case (object name must match ^[a-z][a-z0-9_]*$)' });
      continue;
    }
    if (table.pk.length !== 1) {
      skipped.push({
        table: name,
        reason: table.pk.length === 0 ? 'missing primary key' : 'composite primary key not supported',
      });
      continue;
    }
    const pkName = table.pk[0]!;
    const pkCol = table.columns.find((c) => c.name === pkName);
    if (pkCol === undefined) {
      skipped.push({ table: name, reason: `primary key column "${pkName}" not found` });
      continue;
    }

    let badColumn: string | undefined;
    for (const col of table.columns) {
      if (col.name === pkName) continue;
      if (!SNAKE_CASE.test(col.name)) {
        badColumn = col.name;
        break;
      }
    }
    if (badColumn !== undefined) {
      skipped.push({ table: name, reason: `column name "${badColumn}" is not snake_case` });
      continue;
    }

    const pkField = mapColumn(pkCol, table, warnings);
    if (pkField === undefined) {
      skipped.push({ table: name, reason: `primary key column "${pkName}" type not supported` });
      continue;
    }
    (pkField as unknown as Record<string, unknown>).primary = true;

    const fields: FieldDefinition[] = [pkField];
    for (const col of table.columns) {
      if (col.name === pkName) continue;
      const mapped = mapColumn(col, table, warnings);
      if (mapped !== undefined) fields.push(mapped);
    }

    const schema: Record<string, unknown> = { name, alter: false, fields };
    if (table.comment !== undefined) schema.labels = { [DEFAULT_LOCALE]: table.comment };

    try {
      const validated = validateObject(schema, { nameHint: name });
      objects.push({ name, table: name, schema: validated });
      for (const f of validated.fields) {
        if (f.name === 'owner_id' && f.ownership !== true) suggestions.push(`"${name}.owner_id": consider marking ownership: true`);
        if (f.name === 'team_id' && f.team !== true) suggestions.push(`"${name}.team_id": consider marking team: true`);
      }
    } catch (error) {
      skipped.push({ table: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { objects, skipped, warnings, suggestions };
}
