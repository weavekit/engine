import type { Pool } from 'pg';
import type { WorkflowTimer, WorkflowTimerStore } from '../../core/index.js';

const TABLE = 'weavekit_workflow_timers';

interface TimerRow {
  object: string;
  record_key: string;
  node_id: string;
  due_at: Date;
  workflow_hash: string | null;
}

/**
 * PostgreSQL timer store (engine default). One row per record (`PRIMARY KEY
 * (object, record_key)`); `claimDue` atomically removes the due rows with
 * `FOR UPDATE SKIP LOCKED`, so multiple engine instances never fire the same
 * timer twice. The enterprise seam may replace this with a Redis/HA backend.
 */
export function createPgWorkflowTimerStore(pool: Pool): WorkflowTimerStore {
  return {
    async schedule(timer: WorkflowTimer): Promise<void> {
      await pool.query(
        `INSERT INTO ${TABLE} (object, record_key, node_id, due_at, workflow_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (object, record_key) DO UPDATE SET
           node_id = EXCLUDED.node_id,
           due_at = EXCLUDED.due_at,
           workflow_hash = EXCLUDED.workflow_hash`,
        [timer.object, timer.id, timer.nodeId, timer.dueAt, timer.workflowHash ?? null],
      );
    },

    async cancel(object: string, id: string): Promise<void> {
      await pool.query(`DELETE FROM ${TABLE} WHERE object = $1 AND record_key = $2`, [object, id]);
    },

    async claimDue(limit: number, now: Date): Promise<WorkflowTimer[]> {
      const res = await pool.query(
        `DELETE FROM ${TABLE}
          WHERE ctid IN (
            SELECT ctid FROM ${TABLE}
             WHERE due_at <= $1
             ORDER BY due_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED
          )
        RETURNING object, record_key, node_id, due_at, workflow_hash`,
        [now, limit],
      );
      return (res.rows as TimerRow[]).map((row) => ({
        object: row.object,
        id: row.record_key,
        nodeId: row.node_id,
        dueAt: row.due_at,
        ...(row.workflow_hash === null ? {} : { workflowHash: row.workflow_hash }),
      }));
    },

    async complete(): Promise<void> {
      // `claimDue` already deleted the claimed rows
    },
  };
}
