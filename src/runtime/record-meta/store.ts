import type { Pool, PoolClient } from 'pg';
import {
  RECORD_META_COLUMNS,
  RECORD_META_DEFAULT_STATUS,
  recordMetaTableName,
} from '../../core/storage/record-meta.js';

/**
 * Sparse CRUD over an object's record metadata side table
 * (`weavekit_record__<object>`). Rows are created only when a record gains
 * engine metadata (status change / owner / workflow binding), so a table holds
 * entries only for records that actually carry system state.
 */

type Db = Pool | PoolClient;

const q = (id: string) => `"${id}"`;
const COL = RECORD_META_COLUMNS;

/** a record metadata row */
export interface RecordMeta {
  recordKey: string;
  status: string;
  ownerId: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  createdTime: Date | null;
  modifiedTime: Date | null;
  workflowId: string | null;
}

/** fields that may be written on a sparse upsert (absent = leave unchanged) */
export interface RecordMetaPatch {
  status?: string;
  ownerId?: string | null;
  createdBy?: string | null;
  modifiedBy?: string | null;
  createdTime?: Date | null;
  modifiedTime?: Date | null;
  workflowId?: string | null;
}

interface RawRow {
  record_key: string;
  status: string;
  owner_id: string | null;
  created_by: string | null;
  modified_by: string | null;
  created_time: Date | null;
  modified_time: Date | null;
  workflow_id: string | null;
}

const SELECT_COLUMNS = [
  COL.RECORD_KEY,
  COL.STATUS,
  COL.OWNER_ID,
  COL.CREATED_BY,
  COL.MODIFIED_BY,
  COL.CREATED_TIME,
  COL.MODIFIED_TIME,
  COL.WORKFLOW_ID,
]
  .map(q)
  .join(', ');

function toRecordMeta(row: RawRow): RecordMeta {
  return {
    recordKey: row.record_key,
    status: row.status,
    ownerId: row.owner_id,
    createdBy: row.created_by,
    modifiedBy: row.modified_by,
    createdTime: row.created_time,
    modifiedTime: row.modified_time,
    workflowId: row.workflow_id,
  };
}

/** patch entries mapped to (column, value) pairs, with only defined keys */
function patchEntries(patch: RecordMetaPatch): [string, unknown][] {
  const entries: [string, unknown][] = [];
  const put = (column: string, value: unknown): void => {
    if (value !== undefined) entries.push([column, value]);
  };
  put(COL.STATUS, patch.status);
  put(COL.OWNER_ID, patch.ownerId);
  put(COL.CREATED_BY, patch.createdBy);
  put(COL.MODIFIED_BY, patch.modifiedBy);
  put(COL.CREATED_TIME, patch.createdTime);
  put(COL.MODIFIED_TIME, patch.modifiedTime);
  put(COL.WORKFLOW_ID, patch.workflowId);
  return entries;
}

/** read one record's metadata row (null when the record is sparse/default) */
export async function getRecordMeta(db: Db, object: string, recordKey: string): Promise<RecordMeta | null> {
  const table = recordMetaTableName(object);
  const res = await db.query(`SELECT ${SELECT_COLUMNS} FROM ${q(table)} WHERE ${q(COL.RECORD_KEY)} = $1`, [
    recordKey,
  ]);
  const row = res.rows[0] as RawRow | undefined;
  return row === undefined ? null : toRecordMeta(row);
}

/**
 * Insert or merge a record's metadata row. Absent patch fields are left
 * unchanged on conflict; `status` defaults to `draft` on insert. `created_by`
 * / `created_time` are set on insert only (append-only creation facts).
 */
export async function upsertRecordMeta(
  db: Db,
  object: string,
  recordKey: string,
  patch: RecordMetaPatch = {},
): Promise<void> {
  const table = recordMetaTableName(object);
  const entries = patchEntries(patch);

  const insertCols = [COL.RECORD_KEY, ...entries.map(([c]) => c)];
  const insertVals: unknown[] = [recordKey, ...entries.map(([, v]) => v)];
  if (patch.status === undefined) {
    insertCols.push(COL.STATUS);
    insertVals.push(RECORD_META_DEFAULT_STATUS);
  }

  const immutable = new Set<string>([COL.RECORD_KEY, COL.CREATED_BY, COL.CREATED_TIME]);
  const updates = entries
    .filter(([c]) => !immutable.has(c))
    .map(([c]) => `${q(c)} = EXCLUDED.${q(c)}`);

  await db.query(
    `INSERT INTO ${q(table)} (${insertCols.map(q).join(', ')})
     VALUES (${insertCols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (${q(COL.RECORD_KEY)}) ${updates.length > 0 ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING'}`,
    insertVals,
  );
}

/** delete a record's metadata row (when a record is removed) */
export async function deleteRecordMeta(db: Db, object: string, recordKey: string): Promise<void> {
  const table = recordMetaTableName(object);
  await db.query(`DELETE FROM ${q(table)} WHERE ${q(COL.RECORD_KEY)} = $1`, [recordKey]);
}

/** read metadata rows for a set of records (missing ones are simply absent) */
export async function listRecordMeta(
  db: Db,
  object: string,
  recordKeys: readonly string[],
): Promise<RecordMeta[]> {
  if (recordKeys.length === 0) return [];
  const table = recordMetaTableName(object);
  const res = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM ${q(table)} WHERE ${q(COL.RECORD_KEY)} = ANY($1)`,
    [recordKeys],
  );
  return (res.rows as RawRow[]).map(toRecordMeta);
}
