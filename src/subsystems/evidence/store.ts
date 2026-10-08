import type { Pool } from 'pg';
import { SYSTEM_TABLES, type SqlQueryable } from '../../core/index.js';
import type { Evidence, EvidenceQuery, EvidenceQueryResult, EvidenceSink } from '../../core/index.js';
import { decodeCursor, encodeCursor } from '../../runtime/data-access/cursor.js';

const TABLE = SYSTEM_TABLES.EVIDENCE;

/** append-only insert of one execution evidence row (table created by `weave migrate`) */
export async function insertEvidence(db: SqlQueryable, e: Evidence): Promise<void> {
  await db.query(
    `INSERT INTO ${TABLE}
       (request_id, trace_id, schema_revision, actor_key, actor_label, on_behalf_of, subject_id,
        action, object, object_id, plan, stages, approval_key, is_error, error_code, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16)`,
    [
      e.requestId ?? null,
      e.traceId ?? null,
      e.schemaRevision ?? null,
      e.actor.key,
      e.actor.label,
      e.actor.onBehalfOf ?? null,
      e.subjectId ?? null,
      e.plan.action,
      e.plan.objectName ?? null,
      e.plan.objectId ?? null,
      JSON.stringify(e.plan),
      JSON.stringify(e.stages),
      e.approvalKey ?? null,
      e.isError,
      e.errorCode ?? null,
      e.timestamp,
    ],
  );
}

/** PG-backed evidence sink (`evidence.enabled`); the runtime never emits DDL */
export function createEvidenceSink(pool: Pool): EvidenceSink {
  return {
    record(event) {
      return insertEvidence(pool, event);
    },
  };
}

/** map a `weavekit_evidence` row back to the `Evidence` contract */
function rowToEvidence(row: Record<string, unknown>): Evidence {
  return {
    ...(row.request_id == null ? {} : { requestId: String(row.request_id) }),
    ...(row.trace_id == null ? {} : { traceId: String(row.trace_id) }),
    ...(row.schema_revision == null ? {} : { schemaRevision: String(row.schema_revision) }),
    actor: {
      key: String(row.actor_key),
      label: row.actor_label == null ? '' : String(row.actor_label),
      ...(row.on_behalf_of == null ? {} : { onBehalfOf: String(row.on_behalf_of) }),
    },
    ...(row.subject_id == null ? {} : { subjectId: String(row.subject_id) }),
    plan: row.plan as Evidence['plan'],
    stages: row.stages as Evidence['stages'],
    ...(row.approval_key == null ? {} : { approvalKey: String(row.approval_key) }),
    isError: row.is_error === true,
    ...(row.error_code == null ? {} : { errorCode: String(row.error_code) }),
    timestamp: new Date(row.ts as string),
  };
}

/**
 * Basic, scoped evidence query (newest-first) with offset **or** keyset cursor
 * pagination. The engine only offers this read surface; export / retention /
 * compliance reporting belong to enterprise E2.
 */
export async function queryEvidence(pool: Pool, query: EvidenceQuery = {}): Promise<EvidenceQueryResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (query.action !== undefined) push('action = ?', query.action);
  if (query.objectName !== undefined) push('object = ?', query.objectName);
  if (query.subjectId !== undefined) push('subject_id = ?', query.subjectId);
  if (query.actorKey !== undefined) push('actor_key = ?', query.actorKey);
  if (query.isError !== undefined) push('is_error = ?', query.isError);
  if (query.from !== undefined) push('ts >= ?', query.from);
  if (query.to !== undefined) push('ts <= ?', query.to);
  const whereSql = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;

  const count = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}${whereSql}`, params);
  const total = count.rows[0]?.n ?? 0;

  const limit = query.limit ?? 100;
  const pageWhere = [...where];
  const pageParams = [...params];
  if (query.cursor !== undefined) {
    const [cursorTs, cursorId] = decodeCursor(query.cursor);
    pageParams.push(cursorTs, cursorId);
    pageWhere.push(`("ts", "id") < ($${pageParams.length - 1}, $${pageParams.length})`);
  }
  const offset = query.cursor === undefined ? (query.offset ?? 0) : 0;
  const pageWhereSql = pageWhere.length === 0 ? '' : ` WHERE ${pageWhere.join(' AND ')}`;
  const result = await pool.query(
    `SELECT * FROM ${TABLE}${pageWhereSql} ORDER BY ts DESC, id DESC LIMIT $${pageParams.length + 1} OFFSET $${pageParams.length + 2}`,
    [...pageParams, limit, offset],
  );
  const rows = result.rows.map((row) => rowToEvidence(row as Record<string, unknown>));
  const last = result.rows[result.rows.length - 1] as { ts: unknown; id: unknown } | undefined;
  const nextCursor =
    last !== undefined && limit > 0 && result.rows.length === limit
      ? encodeCursor([new Date(last.ts as string).toISOString(), last.id])
      : undefined;
  return nextCursor === undefined ? { rows, total } : { rows, total, nextCursor };
}
