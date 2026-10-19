import type { Pool } from 'pg';
import type {
  ApprovalListFilter,
  ApprovalPolicySnapshot,
  ApprovalStatus,
  ApprovalsBackend,
  PendingApproval,
} from '../../core/tools/index.js';

const TABLE = 'weavekit_approvals';

const COLUMNS =
  'approval_key, action, args, actor_key, status, created_at, approved_by, resolved_at, requested_by, on_behalf_of, actor_label, request_hash, request_id, policy, expires_at, consumed_at, comment';

interface Row {
  approval_key: string;
  action: string;
  args: unknown;
  actor_key: string;
  status: string;
  created_at: string | Date;
  approved_by: string | null;
  resolved_at: string | Date | null;
  requested_by: string | null;
  on_behalf_of: string | null;
  actor_label: string | null;
  request_hash: string | null;
  request_id: string | null;
  policy: unknown;
  expires_at: string | Date | null;
  consumed_at: string | Date | null;
  comment: string | null;
}

function asDate(value: string | Date | null): Date | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function toApproval(row: Row): PendingApproval {
  return {
    approvalKey: row.approval_key,
    action: row.action,
    args: (row.args ?? {}) as Record<string, unknown>,
    status: row.status as ApprovalStatus,
    createdAt: asDate(row.created_at)!,
    actorKey: row.actor_key,
    ...(row.approved_by == null ? {} : { approvedBy: row.approved_by }),
    ...(row.requested_by == null ? {} : { requestedBy: row.requested_by }),
    ...(row.on_behalf_of == null ? {} : { onBehalfOf: row.on_behalf_of }),
    ...(row.actor_label == null ? {} : { actorLabel: row.actor_label }),
    ...(row.request_hash == null ? {} : { requestHash: row.request_hash }),
    ...(row.request_id == null ? {} : { requestId: row.request_id }),
    ...(row.policy == null ? {} : { policy: row.policy as ApprovalPolicySnapshot }),
    ...(row.expires_at == null ? {} : { expiresAt: asDate(row.expires_at) }),
    ...(row.consumed_at == null ? {} : { consumedAt: asDate(row.consumed_at) }),
    ...(row.resolved_at == null ? {} : { resolvedAt: asDate(row.resolved_at) }),
    ...(row.comment == null ? {} : { comment: row.comment }),
  };
}

/** sort field whitelist (never interpolate raw input into SQL) */
const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  action: 'action',
  actorKey: 'actor_key',
  requestedBy: 'requested_by',
  status: 'status',
  approvalKey: 'approval_key',
};

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
  if (filter.requestedBy !== undefined) push('requested_by = ?', filter.requestedBy);
  if (filter.approvalKey !== undefined) push('approval_key = ?', filter.approvalKey);
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
 * Postgres `ApprovalsBackend` (the release default; the engine's mandated DB).
 * Parameterized, whitelisted sort, idempotent upsert (deterministic key — a
 * resolved/consumed decision is never resurrected by a re-pending). Mirrors
 * `subsystems/audit` conventions (pool-injected, no adapters).
 */
export function createApprovalsPgStore(pool: Pool): ApprovalsBackend {
  return {
    async list(filter = {}): Promise<PendingApproval[]> {
      const where = buildWhere(filter);
      const offset = filter.offset ?? 0;
      const limit = filter.limit ?? 100;
      const result = await pool.query(
        `SELECT ${COLUMNS}
         FROM ${TABLE}${where.sql}${buildOrder(filter)}
         LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        [...where.params, limit, offset],
      );
      return result.rows.map((row) => toApproval(row as Row));
    },
    async get(approvalKey: string): Promise<PendingApproval | undefined> {
      const result = await pool.query(`SELECT ${COLUMNS} FROM ${TABLE} WHERE approval_key = $1`, [approvalKey]);
      const row = result.rows[0];
      return row === undefined ? undefined : toApproval(row as Row);
    },
    async upsert(entry: PendingApproval): Promise<void> {
      await pool.query(
        `INSERT INTO ${TABLE} (
           approval_key, action, args, actor_key, status, created_at, requested_by,
           on_behalf_of, actor_label, request_hash, request_id, policy, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (approval_key) DO NOTHING`,
        [
          entry.approvalKey,
          entry.action,
          JSON.stringify(entry.args),
          entry.actorKey,
          entry.status,
          entry.createdAt,
          entry.requestedBy ?? null,
          entry.onBehalfOf ?? null,
          entry.actorLabel ?? null,
          entry.requestHash ?? null,
          entry.requestId ?? null,
          entry.policy === undefined ? null : JSON.stringify(entry.policy),
          entry.expiresAt ?? null,
        ],
      );
    },
    async resolve(
      approvalKey: string,
      by: string,
      status: 'approved' | 'rejected',
      comment?: string,
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE ${TABLE}
         SET status = $2, approved_by = $3, resolved_at = now(), comment = $4
         WHERE approval_key = $1
           AND status = 'pending'
           AND (expires_at IS NULL OR expires_at > now())`,
        [approvalKey, status, by, comment ?? null],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async consume(approvalKey: string): Promise<boolean> {
      const result = await pool.query(
        `UPDATE ${TABLE}
         SET consumed_at = now()
         WHERE approval_key = $1
           AND status = 'approved'
           AND consumed_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())`,
        [approvalKey],
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
