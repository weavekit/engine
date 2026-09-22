import type { FieldDefinition } from '../types/index.js';
import { DEFAULT_FIELD_TYPE_REGISTRY, fieldBase, type FieldTypeRegistry } from '../types/index.js';
import { FIELD_TYPES, ON_DELETE_ACTIONS } from '../types/values.js';

/**
 * Map a field's declared type to a PostgreSQL column type. Dispatch is driven by
 * the type's **base** primitive (resolved through the field-type registry), so a
 * user/plugin registered type inherits its base's storage automatically.
 * `targetPkType` is the mapped PK type of the target object (for `relation`).
 */
export function pgType(
  field: FieldDefinition,
  targetPkType: string | undefined,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): string {
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
    case FIELD_TYPES.DATETIME:
      return 'TIMESTAMPTZ';
    case FIELD_TYPES.DATE:
      return 'DATE';
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
    case FIELD_TYPES.DATETIME:
    case FIELD_TYPES.DATE:
      return raw.default === 'now' ? 'now()' : `'${String(raw.default)}'`;
    case FIELD_TYPES.ENUM:
      // multi-value enum defaults are not expressed in DDL (application layer)
      return (field as { multiple?: boolean }).multiple ? undefined : `'${String(raw.default)}'`;
    case FIELD_TYPES.STRING:
      // multi-value image defaults are application layer too
      if (field.type === FIELD_TYPES.IMAGE && (field as { multiple?: boolean }).multiple === true) return undefined;
      return `'${String(raw.default)}'`;
    case FIELD_TYPES.TEXT:
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
  INTEGER: 'int4',
};

/**
 * Compare a declared column type (`pgType()` output, e.g. `VARCHAR(255)`,
 * `NUMERIC(12,2)`, `TEXT[]`) against a live `information_schema` column, for
 * the `weave schema:map` drift report. Length on `VARCHAR` is ignored (brownfield
 * tables often declare an unbounded/bespoke varchar); numeric precision/scale is
 * compared only when the declared type specifies them.
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

  if (exp.endsWith('[]')) {
    const isArray = actual.dataType.toUpperCase() === 'ARRAY' || actual.udtName?.startsWith('_') === true;
    if (!isArray) return false;
    const udt = actual.udtName?.replace(/^_/, '').toLowerCase();
    return ARRAY_ELEMENT_UDT[exp.slice(0, -2)] === udt;
  }

  const match = /^([A-Z]+)(?:\(([^)]*)\))?$/.exec(exp);
  if (match === null) return false;
  const base = match[1]!;
  const args = match[2];
  const actualBase = actual.dataType.toUpperCase();

  switch (base) {
    case 'VARCHAR':
      return actualBase === 'CHARACTER VARYING' || actualBase === 'VARCHAR';
    case 'TEXT':
      return actualBase === 'TEXT';
    case 'INTEGER':
      return actualBase === 'INTEGER' || actualBase === 'INT' || actualBase === 'INT4';
    case 'BOOLEAN':
      return actualBase === 'BOOLEAN' || actualBase === 'BOOL';
    case 'DATE':
      return actualBase === 'DATE';
    case 'TIMESTAMPTZ':
      return actualBase === 'TIMESTAMP WITH TIME ZONE';
    case 'JSONB':
      return actualBase === 'JSONB';
    case 'NUMERIC': {
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
