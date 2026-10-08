import type { Pool } from 'pg';
import { SYSTEM_TABLES, type SqlQueryable } from '../../core/index.js';
import type { Evidence, EvidenceSink } from '../../core/index.js';

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
