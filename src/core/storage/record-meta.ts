import type { ExpectedTable } from './diff.js';
import { FIELD_TYPES, WEAVE_STATUS } from '../types/index.js';

/**
 * Engine-owned per-object record metadata ("side table").
 *
 * The iron rule is that the engine never touches a customer table. System
 * metadata (status / ownership / timestamps / workflow binding) therefore lives
 * in an engine-owned table named `weavekit_record__<object>`, keyed by the
 * `record_key` encoding of the record's (possibly composite) primary key
 * (see `core/object/record-key.ts`).
 *
 * One table exists per object (R1: every object, no opt-in) and rows are
 * **sparse** — a record with no engine metadata has no row, so a table only
 * holds entries that actually carry system state.
 */

export const RECORD_META_TABLE_PREFIX = 'weavekit_record__';

/** column names of a record metadata side table (single source) */
export const RECORD_META_COLUMNS = {
  RECORD_KEY: 'record_key',
  STATUS: 'status',
  OWNER_ID: 'owner_id',
  CREATED_BY: 'created_by',
  MODIFIED_BY: 'modified_by',
  CREATED_TIME: 'created_time',
  MODIFIED_TIME: 'modified_time',
  WORKFLOW_ID: 'workflow_id',
} as const;

/** default `status` for a record with a metadata row */
export const RECORD_META_DEFAULT_STATUS = WEAVE_STATUS.DRAFT;

/** reserved prefix for record-metadata virtual fields exposed on reads */
export const RECORD_META_VIRTUAL_PREFIX = 'weave_';

/**
 * the identity virtual field: every record's external id — its `record_key`.
 * Derived from the customer primary key (never a stored column), so clients and
 * agents can round-trip a row back into `REST /:id` / MCP `id`.
 */
export const RECORD_META_ID_FIELD = `${RECORD_META_VIRTUAL_PREFIX}id`;

/** one virtual system field exposed on reads / `describe` (type semantics only) */
export interface RecordMetaVirtualFieldSpec {
  name: string;
  type: string;
  options?: readonly string[];
  multiple?: boolean;
}

/**
 * Virtual system fields exposed on reads and in `describe`, in stable order
 * (`weave_id` first). `weave_id` is computed from the customer primary key;
 * the rest live in the side table. Names are reserved so they never collide
 * with a customer's business fields.
 */
export const RECORD_META_VIRTUAL_FIELD_SPECS: readonly RecordMetaVirtualFieldSpec[] = [
  { name: RECORD_META_ID_FIELD, type: FIELD_TYPES.STRING },
  { name: `${RECORD_META_VIRTUAL_PREFIX}${RECORD_META_COLUMNS.STATUS}`, type: FIELD_TYPES.ENUM, options: Object.values(WEAVE_STATUS) },
  { name: `${RECORD_META_VIRTUAL_PREFIX}${RECORD_META_COLUMNS.OWNER_ID}`, type: FIELD_TYPES.STRING },
  { name: `${RECORD_META_VIRTUAL_PREFIX}${RECORD_META_COLUMNS.CREATED_BY}`, type: FIELD_TYPES.STRING },
  { name: `${RECORD_META_VIRTUAL_PREFIX}${RECORD_META_COLUMNS.MODIFIED_BY}`, type: FIELD_TYPES.STRING },
  { name: `${RECORD_META_VIRTUAL_PREFIX}${RECORD_META_COLUMNS.CREATED_TIME}`, type: FIELD_TYPES.TIMESTAMPTZ },
  { name: `${RECORD_META_VIRTUAL_PREFIX}${RECORD_META_COLUMNS.MODIFIED_TIME}`, type: FIELD_TYPES.TIMESTAMPTZ },
  { name: `${RECORD_META_VIRTUAL_PREFIX}${RECORD_META_COLUMNS.WORKFLOW_ID}`, type: FIELD_TYPES.STRING },
];

/** virtual system field names (derived from the specs — single source) */
export const RECORD_META_VIRTUAL_FIELDS: readonly string[] = RECORD_META_VIRTUAL_FIELD_SPECS.map((s) => s.name);

/** true when a requested field name is a record-metadata virtual field */
export function isRecordMetaVirtualField(name: string): boolean {
  return RECORD_META_VIRTUAL_FIELDS.includes(name);
}

/** true when a virtual field is backed by the side table (all but the derived `weave_id`) */
export function isSideTableVirtualField(name: string): boolean {
  return isRecordMetaVirtualField(name) && name !== RECORD_META_ID_FIELD;
}

/** side-table name for an object */
export function recordMetaTableName(object: string): string {
  return `${RECORD_META_TABLE_PREFIX}${object}`;
}

/** true when a live table name is an engine record-metadata side table */
export function isRecordMetaTable(name: string): boolean {
  return name.startsWith(RECORD_META_TABLE_PREFIX);
}

/**
 * The expected (DDL) shape of an object's record metadata side table. `owner_id`
 * / `created_by` / `modified_by` are intentionally FK-less here: the identity
 * tables (`weavekit_user`) land with the identity subsystem, and orphan cleanup
 * is handled at the data-access layer, not by a hard FK.
 */
export function buildRecordMetaTable(object: string): ExpectedTable {
  const name = recordMetaTableName(object);
  const text = { type: 'TEXT', notNull: false, primary: false, unique: false } as const;
  const ts = { type: 'TIMESTAMPTZ', notNull: false, primary: false, unique: false } as const;
  return {
    name,
    columns: [
      { name: RECORD_META_COLUMNS.RECORD_KEY, type: 'TEXT', notNull: true, primary: true, unique: false },
      {
        name: RECORD_META_COLUMNS.STATUS,
        type: 'TEXT',
        notNull: true,
        default: `'${RECORD_META_DEFAULT_STATUS}'`,
        primary: false,
        unique: false,
      },
      { name: RECORD_META_COLUMNS.OWNER_ID, ...text },
      { name: RECORD_META_COLUMNS.CREATED_BY, ...text },
      { name: RECORD_META_COLUMNS.MODIFIED_BY, ...text },
      { name: RECORD_META_COLUMNS.CREATED_TIME, ...ts },
      { name: RECORD_META_COLUMNS.MODIFIED_TIME, ...ts },
      { name: RECORD_META_COLUMNS.WORKFLOW_ID, type: 'TEXT', notNull: false, primary: false, unique: false },
    ],
    fks: [],
    indexes: [
      { name: `${name}_status_idx`, method: 'btree', columns: [RECORD_META_COLUMNS.STATUS] },
      { name: `${name}_owner_idx`, method: 'btree', columns: [RECORD_META_COLUMNS.OWNER_ID] },
    ],
    uniques: [],
  };
}
