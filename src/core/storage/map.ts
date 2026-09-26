import type { FieldDefinition, RegisteredField } from '../types/index.js';
import { DEFAULT_FIELD_TYPE_REGISTRY, fieldBase, type FieldTypeRegistry } from '../types/index.js';
import { SchemaError } from '../types/errors.js';
import { FIELD_TYPES, ON_DELETE_ACTIONS } from '../types/values.js';

/** base PostgreSQL type names a registered `storage.pgType` may return */
const SAFE_PG_BASE: ReadonlySet<string> = new Set([
  'VARCHAR',
  'CHARACTER VARYING',
  'CHAR',
  'BPCHAR',
  'TEXT',
  'SMALLINT',
  'INTEGER',
  'INT',
  'INT2',
  'INT4',
  'INT8',
  'BIGINT',
  'NUMERIC',
  'DECIMAL',
  'REAL',
  'DOUBLE PRECISION',
  'BOOLEAN',
  'DATE',
  'TIME',
  'TIMETZ',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'TIMESTAMP WITH TIME ZONE',
  'TIMESTAMP WITHOUT TIME ZONE',
  'JSON',
  'JSONB',
  'UUID',
  'MONEY',
]);

const SAFE_PG_RE = /^([A-Z][A-Z0-9_ ]*?)(\(\d+(?:\s*,\s*\d+)?\))?(\[\])?$/;

/**
 * True when a registered `storage.pgType` output is a safe PostgreSQL column
 * type: a known base type with optional numeric parameters and an optional
 * array suffix. Rejects anything that could inject SQL (quotes, semicolons).
 */
export function isSafePgType(value: string): boolean {
  const match = SAFE_PG_RE.exec(value.trim().toUpperCase());
  if (match === null) return false;
  return SAFE_PG_BASE.has(match[1]!.trim());
}

/**
 * Map a field's declared type to a PostgreSQL column type. Dispatch is driven by
 * the type's **base** primitive (resolved through the field-type registry), so a
 * user/plugin registered type inherits its base's storage automatically — unless
 * it declares a custom `storage.pgType` hook (whose output is safety-checked).
 * `targetPkType` is the mapped PK type of the target object (for `relation`).
 */
export function pgType(
  field: FieldDefinition,
  targetPkType: string | undefined,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): string {
  const descriptor = registry.get(field.type);
  if (descriptor?.storage !== undefined) {
    const mapped = descriptor.storage.pgType(field as unknown as RegisteredField);
    if (typeof mapped !== 'string' || !isSafePgType(mapped)) {
      throw new SchemaError('fieldtype.storage.invalid', {
        name: field.type,
        detail: `storage.pgType returned "${String(mapped)}", which is not a safe PostgreSQL type`,
      });
    }
    return mapped.trim().toUpperCase();
  }

  const base = fieldBase(registry, field.type);
  switch (base) {
    case FIELD_TYPES.STRING:
      // media (image) base=string but a multi-value is an array column
      if (field.type === FIELD_TYPES.IMAGE && (field as { multiple?: boolean }).multiple === true) return 'TEXT[]';
      return 'VARCHAR(255)';
    case FIELD_TYPES.TEXT:
      return 'TEXT';
    case FIELD_TYPES.INTEGER:
      return 'INTEGER';
    case FIELD_TYPES.NUMBER:
      return (field as { precision?: number }).precision
        ? `NUMERIC(${(field as { precision?: number }).precision})`
        : 'NUMERIC';
    case FIELD_TYPES.CURRENCY:
      return 'NUMERIC(12,2)';
    case FIELD_TYPES.BOOLEAN:
      return 'BOOLEAN';
    case FIELD_TYPES.DATE:
      return 'DATE';
    case FIELD_TYPES.TIME:
      return 'TIME';
    case FIELD_TYPES.TIMETZ:
      return 'TIMETZ';
    case FIELD_TYPES.TIMESTAMP:
      return 'TIMESTAMP';
    case FIELD_TYPES.TIMESTAMPTZ:
      return 'TIMESTAMPTZ';
    case FIELD_TYPES.INTERVAL:
      return 'INTERVAL';
    case FIELD_TYPES.UUID:
      return 'UUID';
    case FIELD_TYPES.JSON:
      return 'JSONB';
    case FIELD_TYPES.ENUM:
      return (field as { multiple?: boolean }).multiple ? 'TEXT[]' : 'VARCHAR(255)';
    case FIELD_TYPES.RELATION:
      return targetPkType ?? 'VARCHAR(255)';
    case FIELD_TYPES.MULTI_RELATION:
      return 'TEXT[]';
    case FIELD_TYPES.SEQ_NO:
      return 'VARCHAR(255)';
    case FIELD_TYPES.DETAILS:
      throw new Error('details fields do not create a column');
    default:
      throw new Error(`unknown field type "${field.type}"`);
  }
}

/** SQL DEFAULT expression for a field's `default` value, or undefined (no default) */
export function defaultExpr(
  field: FieldDefinition,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): string | undefined {
  const raw = field as { default?: unknown; multiple?: boolean };
  if (raw.default === undefined) return undefined;
  const base = fieldBase(registry, field.type);
  switch (base) {
    case FIELD_TYPES.DATE:
    case FIELD_TYPES.TIMESTAMP:
    case FIELD_TYPES.TIMESTAMPTZ:
      return raw.default === 'now' ? 'now()' : `'${String(raw.default)}'`;
    case FIELD_TYPES.TIME:
    case FIELD_TYPES.TIMETZ:
      return `'${String(raw.default)}'`;
    case FIELD_TYPES.ENUM:
      // multi-value enum defaults are not expressed in DDL (application layer)
      return (field as { multiple?: boolean }).multiple ? undefined : `'${String(raw.default)}'`;
    case FIELD_TYPES.STRING:
      // multi-value image defaults are application layer too
      if (field.type === FIELD_TYPES.IMAGE && (field as { multiple?: boolean }).multiple === true) return undefined;
      return `'${String(raw.default)}'`;
    case FIELD_TYPES.TEXT:
    case FIELD_TYPES.UUID:
      return `'${String(raw.default)}'`;
    case FIELD_TYPES.BOOLEAN:
      return String(raw.default);
    case FIELD_TYPES.INTEGER:
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
      return String(raw.default);
    default:
      return undefined;
  }
}

/** element `udt_name` (without the leading underscore) for engine array columns */
const ARRAY_ELEMENT_UDT: Record<string, string> = {
  TEXT: 'text',
  VARCHAR: 'varchar',
  'CHARACTER VARYING': 'varchar',
  CHAR: 'bpchar',
  BPCHAR: 'bpchar',
  SMALLINT: 'int2',
  INT2: 'int2',
  INTEGER: 'int4',
  INT: 'int4',
  INT4: 'int4',
  BIGINT: 'int8',
  INT8: 'int8',
  NUMERIC: 'numeric',
  DECIMAL: 'numeric',
  REAL: 'float4',
  'DOUBLE PRECISION': 'float8',
  BOOLEAN: 'bool',
  DATE: 'date',
  TIME: 'time',
  TIMETZ: 'timetz',
  TIMESTAMP: 'timestamp',
  TIMESTAMPTZ: 'timestamptz',
  'TIMESTAMP WITH TIME ZONE': 'timestamptz',
  'TIMESTAMP WITHOUT TIME ZONE': 'timestamp',
  JSON: 'json',
  JSONB: 'jsonb',
  UUID: 'uuid',
  MONEY: 'money',
};

/**
 * Compare a declared column type (`pgType()` output, e.g. `VARCHAR(255)`,
 * `NUMERIC(12,2)`, `TEXT[]`, or a custom `storage.pgType` value) against a live
 * `information_schema` column, for the `weave schema:map` drift report. Length on
 * `VARCHAR` is ignored (brownfield tables often declare an unbounded/bespoke
 * varchar); numeric precision/scale is compared only when the declared type
 * specifies them. Accepts the same type vocabulary as `isSafePgType`, so a
 * custom storage mapping never reports a false drift.
 */
export function pgTypeMatches(
  expected: string,
  actual: {
    dataType: string;
    udtName?: string;
    numericPrecision?: number | null;
    numericScale?: number | null;
  },
): boolean {
  const exp = expected.trim().toUpperCase();
  const match = /^([A-Z][A-Z ]*?)(?:\(([^)]*)\))?(\[\])?$/.exec(exp);
  if (match === null) return false;
  const base = match[1]!.trim();
  const args = match[2];
  const isArray = match[3] !== undefined;

  if (isArray) {
    const liveIsArray = actual.dataType.toUpperCase() === 'ARRAY' || actual.udtName?.startsWith('_') === true;
    if (!liveIsArray) return false;
    const udt = actual.udtName?.replace(/^_/, '').toLowerCase();
    return ARRAY_ELEMENT_UDT[base] === udt;
  }

  const actualBase = actual.dataType.toUpperCase();

  switch (base) {
    case 'VARCHAR':
    case 'CHARACTER VARYING':
      return actualBase === 'CHARACTER VARYING' || actualBase === 'VARCHAR';
    case 'CHAR':
    case 'BPCHAR':
      return actualBase === 'CHARACTER' || actualBase === 'CHAR' || actualBase === 'BPCHAR';
    case 'TEXT':
      return actualBase === 'TEXT';
    case 'SMALLINT':
    case 'INT2':
      return actualBase === 'SMALLINT' || actualBase === 'INT2';
    case 'INTEGER':
    case 'INT':
    case 'INT4':
      return actualBase === 'INTEGER' || actualBase === 'INT' || actualBase === 'INT4';
    case 'BIGINT':
    case 'INT8':
      return actualBase === 'BIGINT' || actualBase === 'INT8';
    case 'REAL':
      return actualBase === 'REAL' || actualBase === 'FLOAT4';
    case 'DOUBLE PRECISION':
      return actualBase === 'DOUBLE PRECISION' || actualBase === 'FLOAT8';
    case 'BOOLEAN':
      return actualBase === 'BOOLEAN' || actualBase === 'BOOL';
    case 'DATE':
      return actualBase === 'DATE';
    case 'TIME':
      return actualBase === 'TIME' || actualBase === 'TIME WITHOUT TIME ZONE';
    case 'TIMETZ':
      return actualBase === 'TIME WITH TIME ZONE';
    case 'TIMESTAMP':
      return actualBase === 'TIMESTAMP' || actualBase === 'TIMESTAMP WITHOUT TIME ZONE';
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP WITH TIME ZONE':
      return actualBase === 'TIMESTAMP WITH TIME ZONE';
    case 'INTERVAL':
      return actualBase === 'INTERVAL';
    case 'JSON':
      return actualBase === 'JSON';
    case 'JSONB':
      return actualBase === 'JSONB';
    case 'UUID':
      return actualBase === 'UUID';
    case 'MONEY':
      return actualBase === 'MONEY';
    case 'NUMERIC':
    case 'DECIMAL': {
      if (actualBase !== 'NUMERIC' && actualBase !== 'DECIMAL') return false;
      if (args === undefined) return true;
      const [precision, scale] = args.split(',').map((part) => Number(part.trim()));
      if (Number.isFinite(precision) && actual.numericPrecision != null && actual.numericPrecision !== precision) {
        return false;
      }
      if (scale !== undefined && Number.isFinite(scale) && actual.numericScale != null && actual.numericScale !== scale) {
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Map a declared `onDelete` action value to the SQL `ON DELETE` clause fragment.
 * Values are the single source `ON_DELETE_ACTIONS` (`cascade`/`restrict`/
 * `set_null`); the SQL spelling differs for `set_null` → `SET NULL` (a bare
 * `SET_NULL` is invalid PostgreSQL). Unknown values fall back to `RESTRICT`
 * (the DDL default) so a stray value never emits broken SQL.
 */
export function onDeleteClause(action: string | undefined): string {
  switch (action) {
    case ON_DELETE_ACTIONS.CASCADE:
      return 'CASCADE';
    case ON_DELETE_ACTIONS.SET_NULL:
      return 'SET NULL';
    case ON_DELETE_ACTIONS.RESTRICT:
    default:
      return 'RESTRICT';
  }
}
