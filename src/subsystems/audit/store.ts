import type { Pool } from 'pg';
import type { AuditEvent, AuditQuery, AuditQueryResult } from '../../core/audit/index.js';
import { FILTER_OPS } from '../../runtime/data-access/values.js';

export type { AuditQuery, AuditQueryResult } from '../../core/audit/index.js';

/** generic-filter whitelist: `weavekit_audit` columns → SQL kind (only these are ever interpolated as identifiers) */
const AUDIT_FILTER_COLUMNS = new Map<string, 'boolean' | 'text' | 'timestamptz'>([
  ['ts', 'timestamptz'],
  ['actor_type', 'text'],
  ['actor_id', 'text'],
  ['action', 'text'],
  ['object', 'text'],
  ['object_id', 'text'],
  ['is_error', 'boolean'],
  ['error_code', 'text'],
]);

const TABLE = 'weavekit_audit';

/** create the append-only audit table (idempotent); `before`/`after` columns are always present (M10 D7 — replay only decides whether they are filled, so toggling the switch needs no migration) */
export async function ensureAuditTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id          bigserial PRIMARY KEY,
       ts          timestamptz NOT NULL DEFAULT now(),
       actor_type  text NOT NULL,
       actor_id    text NOT NULL,
       action      text NOT NULL,
       object      text,
       object_id   text,
       changes     jsonb,
       before      jsonb,
       after       jsonb,
       is_error    boolean NOT NULL DEFAULT false,
       error_code  text,
       meta        jsonb
     )`,
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_ts_idx ON ${TABLE} (ts DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_actor_idx ON ${TABLE} (actor_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_obj_idx ON ${TABLE} (object, object_id)`);
}

/** single append-only insert (writes the event's own timestamp — the audit is time-anchored to the business moment) */
export async function insertAudit(pool: Pool, event: AuditEvent): Promise<void> {
  await pool.query(
    `INSERT INTO ${TABLE} (actor_type, actor_id, action, object, object_id, changes, before, after, is_error, error_code, meta, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      event.actorType,
      event.actorId,
      event.action,
      event.objectName ?? null,
      event.objectId ?? null,
      event.changes === undefined ? null : JSON.stringify(event.changes),
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
      event.isError ?? false,
      event.errorCode ?? null,
      event.meta === undefined ? null : JSON.stringify(event.meta),
      event.timestamp,
    ],
  );
}

/** batch append-only insert (single multi-row statement, one transaction) */
export async function insertAuditBatch(pool: Pool, events: AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  for (const event of events) {
    const i = params.length;
    params.push(event.actorType, event.actorId, event.action,
      event.objectName ?? null, event.objectId ?? null,
      event.changes === undefined ? null : JSON.stringify(event.changes),
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
      event.isError ?? false, event.errorCode ?? null,
      event.meta === undefined ? null : JSON.stringify(event.meta),
      event.timestamp);
    values.push(
      `($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8}, $${i + 9}, $${i + 10}, $${i + 11}, $${i + 12})`,
    );
  }
  await pool.query(
    `INSERT INTO ${TABLE} (actor_type, actor_id, action, object, object_id, changes, before, after, is_error, error_code, meta, ts)
     VALUES ${values.join(', ')}`,
    params,
  );
}

/**
 * One `weavekit_audit` field condition. `rawValue` is a bare scalar (`eq`) or a
 * `{ op: value }` object (multiple ops AND'd, e.g. a `ts` range). Unknown
 * column → `null` (ignored); unsupported op for the column's kind → its piece is
 * skipped. Returns `{ sql, params }` where params are `$1..$k` (callers append
 * via `params.push(...)`).
 */
function auditFieldCondition(
  name: string,
  rawValue: unknown,
): { sql: string; params: unknown[] } | null {
  const kind = AUDIT_FILTER_COLUMNS.get(name);
  if (kind === undefined) return null;

  const ops: Array<{ op: string; value: unknown }> =
    typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)
      ? Object.entries(rawValue).map(([op, value]) => ({ op, value }))
      : [{ op: FILTER_OPS.EQ, value: rawValue }];

  const col = `"${name}"`;
  const pieces: Array<{ sql: string; value: unknown }> = [];
  for (const { op, value } of ops) {
    const supported = ((): boolean => {
      if (kind === 'boolean') return op === FILTER_OPS.EQ || op === FILTER_OPS.NE;
      return (
        op === FILTER_OPS.EQ ||
        op === FILTER_OPS.NE ||
        op === FILTER_OPS.GT ||
        op === FILTER_OPS.GTE ||
        op === FILTER_OPS.LT ||
        op === FILTER_OPS.LTE ||
        op === FILTER_OPS.IN ||
        op === FILTER_OPS.LIKE
      );
    })();
    if (!supported) continue;
    switch (op) {
      case FILTER_OPS.EQ:
        pieces.push({ sql: `${col} = ?`, value });
        break;
      case FILTER_OPS.NE:
        pieces.push({ sql: `${col} <> ?`, value });
        break;
      case FILTER_OPS.GT:
        pieces.push({ sql: `${col} > ?`, value });
        break;
      case FILTER_OPS.GTE:
        pieces.push({ sql: `${col} >= ?`, value });
        break;
      case FILTER_OPS.LT:
        pieces.push({ sql: `${col} < ?`, value });
        break;
      case FILTER_OPS.LTE:
        pieces.push({ sql: `${col} <= ?`, value });
        break;
      case FILTER_OPS.IN:
        pieces.push({ sql: `${col} = ANY(?)`, value });
        break;
      case FILTER_OPS.LIKE:
        pieces.push({ sql: `${col} ILIKE ?`, value: `%${String(value)}%` });
        break;
    }
  }
  if (pieces.length === 0) return null;

  const params: unknown[] = [];
  const sql = pieces
    .map((p, i) => {
      params.push(p.value);
      return p.sql.replace('?', `$${i + 1}`);
    })
    .join(' AND ');
  return pieces.length === 1 ? { sql, params } : { sql: `(${sql})`, params };
}

/** build the generic-filter WHERE fragment (appended to the typed-field `where`) */
function auditFilterWhere(filter: AuditQuery['filter'], where: string[], params: unknown[]): void {
  if (filter === undefined) return;
  for (const [name, rawValue] of Object.entries(filter)) {
    if (name === '$or') continue;
    const built = auditFieldCondition(name, rawValue);
    if (built === null) continue;
    const renumbered = built.sql.replace(/\$\d+/g, (m) => `$${params.length + Number(m.slice(1))}`);
    params.push(...built.params);
    where.push(renumbered);
  }
  const orGroups = filter.$or;
  if (orGroups !== undefined && orGroups.length > 0) {
    const orClauses: string[] = [];
    for (const group of orGroups) {
      const inner: string[] = [];
      for (const [name, rawValue] of Object.entries(group)) {
        const built = auditFieldCondition(name, rawValue);
        if (built === null) continue;
        const renumbered = built.sql.replace(/\$\d+/g, (m) => `$${params.length + Number(m.slice(1))}`);
        params.push(...built.params);
        inner.push(renumbered);
      }
      if (inner.length > 0) orClauses.push(`(${inner.join(' AND ')})`);
    }
    if (orClauses.length > 0) where.push(`(${orClauses.join(' OR ')})`);
  }
}

/** parameterized query over the audit trail */
export async function queryAudit(pool: Pool, query: AuditQuery = {}): Promise<AuditQueryResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (query.actorId !== undefined) push('actor_id = ?', query.actorId);
  if (query.action !== undefined) push('action = ?', query.action);
  if (query.object !== undefined) push('object = ?', query.object);
  if (query.from !== undefined) push('ts >= ?', query.from);
  if (query.to !== undefined) push('ts <= ?', query.to);
  auditFilterWhere(query.filter, where, params);
  const whereSql = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;

  const count = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}${whereSql}`, params);
  const total = count.rows[0]?.n ?? 0;

  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  const pageParams = [...params, limit, offset];
  const result = await pool.query(
    `SELECT ts, actor_type, actor_id, action, object, object_id, changes, before, after, is_error, error_code, meta
     FROM ${TABLE}${whereSql}
     ORDER BY ts DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    pageParams,
  );
  const rows = result.rows.map((row) => ({
    actorType: row.actor_type as AuditEvent['actorType'],
    actorId: row.actor_id as string,
    action: row.action as string,
    objectName: row.object ?? undefined,
    objectId: row.object_id ?? undefined,
    changes: row.changes ?? undefined,
    before: row.before ?? undefined,
    after: row.after ?? undefined,
    isError: row.is_error as boolean,
    errorCode: row.error_code ?? undefined,
    meta: row.meta ?? undefined,
    timestamp: new Date(row.ts as string),
  }));
  return { rows, total };
}
