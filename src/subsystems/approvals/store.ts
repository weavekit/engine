import type { Pool } from 'pg';
import type { ApprovalListFilter, ApprovalStatus, ApprovalsBackend, PendingApproval } from '../../core/tools/index.js';

const TABLE = 'weavekit_approvals';

/** idempotent table creation + indexes (append-query-friendly: status+created, actor) */
export async function ensureApprovalsTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       approval_key text PRIMARY KEY,
       action       text NOT NULL,
       args         jsonb NOT NULL,
       actor_key    text NOT NULL,
       status       text NOT NULL,
       created_at   timestamptz NOT NULL DEFAULT now(),
       approved_by  text,
       resolved_at  timestamptz
     )`,
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_status_created_idx ON ${TABLE} (status, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_actor_idx ON ${TABLE} (actor_key)`);
}

interface Row {
  approval_key: string;
  action: string;
  args: unknown;
  actor_key: string;
  status: string;
  created_at: string;
  approved_by: string | null;
}

function toApproval(row: Row): PendingApproval {
  return {
    approvalKey: row.approval_key,
    action: row.action,
    args: (row.args ?? {}) as Record<string, unknown>,
    status: row.status as ApprovalStatus,
    createdAt: new Date(row.created_at),
    actorKey: row.actor_key,
    approvedBy: row.approved_by ?? undefined,
  };
}

/** sort field whitelist (never interpolate raw input into SQL) */
const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  action: 'action',
  actorKey: 'actor_key',
  status: 'status',
  approvalKey: 'approval_key',
};

function buildColumns(read: 'all'): string {
  return read === 'all'
    ? 'approval_key, action, args, actor_key, status, created_at, approved_by'
    : 'approval_key, action, args, actor_key, status, created_at, approved_by';
}

interface Where {
  sql: string;
  params: unknown[];
}

function buildWhere(filter: ApprovalListFilter): Where {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    params.push(value);
    clauses.push(clause.replace('?', `$${params.length}`));
  };
  if (filter.status !== undefined) push('status = ?', filter.status);
  if (filter.action !== undefined) push('action = ?', filter.action);
  if (filter.actorKey !== undefined) push('actor_key = ?', filter.actorKey);
  if (filter.from !== undefined) push('created_at >= ?', filter.from);
  if (filter.to !== undefined) push('created_at <= ?', filter.to);
  return { sql: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, params };
}

function buildOrder(filter: ApprovalListFilter): string {
  const key = filter.sort?.field ?? 'createdAt';
  const column = SORT_COLUMNS[key] ?? SORT_COLUMNS.createdAt!;
  const order = filter.sort?.order === 'ASC' ? 'ASC' : 'DESC';
  return ` ORDER BY ${column} ${order}`;
}

/**
 * Postgres `ApprovalsBackend` (D1 release default; the engine's mandated DB).
 * Parameterized, whitelisted sort, idempotent upsert (deterministic key → a
 * resolved decision is never resurrected by a re-pending). Mirrors
 * `subsystems/audit` conventions (pool-injected, no adapters).
 */
export function createApprovalsPgStore(pool: Pool): ApprovalsBackend {
  return {
    async list(filter = {}): Promise<PendingApproval[]> {
      const where = buildWhere(filter);
      const offset = filter.offset ?? 0;
      const limit = filter.limit ?? 100;
      const result = await pool.query(
        `SELECT ${buildColumns('all')}
         FROM ${TABLE}${where.sql}${buildOrder(filter)}
         LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        [...where.params, limit, offset],
      );
      return result.rows.map((row) => toApproval(row as Row));
    },
    async get(approvalKey: string): Promise<PendingApproval | undefined> {
      const result = await pool.query(`SELECT ${buildColumns('all')} FROM ${TABLE} WHERE approval_key = $1`, [
        approvalKey,
      ]);
      const row = result.rows[0];
      return row === undefined ? undefined : toApproval(row as Row);
    },
    async upsert(entry: PendingApproval): Promise<void> {
      await pool.query(
        `INSERT INTO ${TABLE} (approval_key, action, args, actor_key, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (approval_key) DO NOTHING`,
        [entry.approvalKey, entry.action, JSON.stringify(entry.args), entry.actorKey, entry.status, entry.createdAt],
      );
    },
    async resolve(approvalKey: string, by: string, status: 'approved' | 'rejected'): Promise<boolean> {
      const result = await pool.query(
        `UPDATE ${TABLE}
         SET status = $2, approved_by = $3, resolved_at = now()
         WHERE approval_key = $1 AND status = 'pending'`,
        [approvalKey, status, by],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async count(filter = {}): Promise<number> {
      const where = buildWhere(filter);
      const result = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}${where.sql}`, where.params);
      return result.rows[0]?.n ?? 0;
    },
  };
}
