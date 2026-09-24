import type { Pool } from 'pg';
import type { WorkflowTimer, WorkflowTimerStore } from '../../core/index.js';

const TABLE = 'weavekit_workflow_timers';

/** create the durable timer table (idempotent); one timer per record */
export async function ensureWorkflowTimersTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       object text NOT NULL,
       id     text NOT NULL,
       state  text NOT NULL,
       due_at timestamptz NOT NULL,
       workflow_version integer,
       workflow_hash    text,
       PRIMARY KEY (object, id)
     )`,
  );
  // additive columns for tables created before definition-identity tracking
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS workflow_version integer`);
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS workflow_hash text`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_due_idx ON ${TABLE} (due_at)`);
}

interface TimerRow {
  object: string;
  id: string;
  state: string;
  due_at: Date;
  workflow_version: number | null;
  workflow_hash: string | null;
}

/**
 * PostgreSQL timer store (engine default). One row per record (`PRIMARY KEY
 * (object, id)`); `claimDue` atomically removes the due rows with
 * `FOR UPDATE SKIP LOCKED`, so multiple engine instances never fire the same
 * timer twice. The enterprise seam may replace this with a Redis/HA backend.
 */
export function createPgWorkflowTimerStore(pool: Pool): WorkflowTimerStore {
  return {
    async schedule(timer: WorkflowTimer): Promise<void> {
      await pool.query(
        `INSERT INTO ${TABLE} (object, id, state, due_at, workflow_version, workflow_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (object, id) DO UPDATE SET
           state = EXCLUDED.state,
           due_at = EXCLUDED.due_at,
           workflow_version = EXCLUDED.workflow_version,
           workflow_hash = EXCLUDED.workflow_hash`,
        [
          timer.object,
          timer.id,
          timer.state,
          timer.dueAt,
          timer.workflowVersion ?? null,
          timer.workflowHash ?? null,
        ],
      );
    },

    async cancel(object: string, id: string): Promise<void> {
      await pool.query(`DELETE FROM ${TABLE} WHERE object = $1 AND id = $2`, [object, id]);
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
        RETURNING object, id, state, due_at, workflow_version, workflow_hash`,
        [now, limit],
      );
      return (res.rows as TimerRow[]).map((row) => ({
        object: row.object,
        id: row.id,
        state: row.state,
        dueAt: row.due_at,
        ...(row.workflow_version === null ? {} : { workflowVersion: row.workflow_version }),
        ...(row.workflow_hash === null ? {} : { workflowHash: row.workflow_hash }),
      }));
    },

    async complete(): Promise<void> {
      // `claimDue` already deleted the claimed rows
    },
  };
}
