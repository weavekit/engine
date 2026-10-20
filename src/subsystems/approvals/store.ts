import type { Pool, PoolClient } from 'pg';
import type {
  ApprovalListFilter,
  ApprovalPolicySnapshot,
  ApprovalStatus,
  ApprovalVote,
  ApprovalsBackend,
  PendingApproval,
} from '../../core/tools/index.js';

const TABLE = 'weavekit_approvals';
const VOTES_TABLE = 'weavekit_approval_votes';

const COLUMNS =
  'approval_key, action, args, actor_key, status, created_at, approved_by, resolved_at, requested_by, on_behalf_of, actor_label, request_hash, request_id, policy, expires_at, consumed_at, comment, required_approvals, approver_roles, approver_groups, approved_count, rejected_by, escalate_after_ms, escalated_at, escalation_approvers';

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
  required_approvals: number | null;
  approver_roles: unknown;
  approver_groups: unknown;
  approved_count: number | null;
  rejected_by: string | null;
  escalate_after_ms: string | number | null;
  escalated_at: string | Date | null;
  escalation_approvers: unknown;
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
    ...(row.required_approvals == null ? {} : { requiredApprovals: row.required_approvals }),
    ...(row.approver_roles == null ? {} : { approverRoles: row.approver_roles as string[] }),
    ...(row.approver_groups == null ? {} : { approverGroups: row.approver_groups as string[] }),
    ...(row.approved_count == null ? {} : { approvedCount: row.approved_count }),
    ...(row.rejected_by == null ? {} : { rejectedBy: row.rejected_by }),
    ...(row.escalate_after_ms == null ? {} : { escalateAfterMs: Number(row.escalate_after_ms) }),
    ...(row.escalated_at == null ? {} : { escalatedAt: asDate(row.escalated_at) }),
    ...(row.escalation_approvers == null
      ? {}
      : { escalationApprovers: row.escalation_approvers as string[] }),
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
  if (filter.expiresBefore !== undefined) push('expires_at < ?', filter.expiresBefore);
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
  const inTransaction = async <T>(fn: (db: Pool | PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

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
           on_behalf_of, actor_label, request_hash, request_id, policy, expires_at,
           required_approvals, approver_roles, approver_groups, approved_count,
           escalate_after_ms, escalation_approvers
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
          entry.requiredApprovals ?? 1,
          entry.approverRoles === undefined ? null : JSON.stringify(entry.approverRoles),
          entry.approverGroups === undefined ? null : JSON.stringify(entry.approverGroups),
          entry.approvedCount ?? 0,
          entry.escalateAfterMs ?? null,
          entry.escalationApprovers === undefined
            ? null
            : JSON.stringify(entry.escalationApprovers),
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
    async vote(approvalKey: string, vote: ApprovalVote): Promise<boolean> {
      return inTransaction(async (db) => {
        const locked = await db.query(
          `SELECT ${COLUMNS} FROM ${TABLE} WHERE approval_key = $1 FOR UPDATE`,
          [approvalKey],
        );
        const row = locked.rows[0];
        if (row === undefined) return false;
        const entry = toApproval(row as Row);
        if (entry.status !== 'pending') return false;
        if (entry.expiresAt !== undefined && entry.expiresAt.getTime() <= Date.now()) return false;
        if (entry.requestedBy !== undefined && entry.requestedBy === vote.approver) return false;

        const existing = await db.query<{ decision: string }>(
          `SELECT decision FROM ${VOTES_TABLE} WHERE approval_key = $1 AND approver = $2`,
          [approvalKey, vote.approver],
        );
        if (existing.rows[0] !== undefined) return existing.rows[0].decision === vote.decision;

        await db.query(
          `INSERT INTO ${VOTES_TABLE} (approval_key, approver, decision, comment, stage, delegated_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            approvalKey,
            vote.approver,
            vote.decision,
            vote.comment ?? null,
            vote.stage ?? 0,
            vote.delegatedBy ?? null,
            vote.createdAt,
          ],
        );
        const count = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${VOTES_TABLE}
           WHERE approval_key = $1 AND decision = 'approved'`,
          [approvalKey],
        );
        const approvedCount = count.rows[0]?.n ?? 0;
        if (vote.decision === 'rejected') {
          await db.query(
            `UPDATE ${TABLE}
             SET status = 'rejected', approved_by = $2, rejected_by = $2, resolved_at = $3,
                 comment = $4, approved_count = $5
             WHERE approval_key = $1 AND status = 'pending'`,
            [approvalKey, vote.approver, vote.createdAt, vote.comment ?? null, approvedCount],
          );
        } else if (approvedCount >= (entry.requiredApprovals ?? 1)) {
          await db.query(
            `UPDATE ${TABLE}
             SET status = 'approved', approved_by = $2, resolved_at = $3, approved_count = $4,
                 comment = COALESCE($5, comment)
             WHERE approval_key = $1 AND status = 'pending'`,
            [approvalKey, vote.approver, vote.createdAt, approvedCount, vote.comment ?? null],
          );
        } else {
          await db.query(
            `UPDATE ${TABLE} SET approved_count = $2 WHERE approval_key = $1 AND status = 'pending'`,
            [approvalKey, approvedCount],
          );
        }
        return true;
      });
    },
    async votes(approvalKey: string): Promise<ApprovalVote[]> {
      const result = await pool.query<{
        approval_key: string;
        approver: string;
        decision: string;
        comment: string | null;
        stage: number;
        delegated_by: string | null;
        created_at: string | Date;
      }>(
        `SELECT approval_key, approver, decision, comment, stage, delegated_by, created_at
         FROM ${VOTES_TABLE} WHERE approval_key = $1 ORDER BY created_at ASC, approver ASC`,
        [approvalKey],
      );
      return result.rows.map((row) => ({
        approvalKey: row.approval_key,
        approver: row.approver,
        decision: row.decision as 'approved' | 'rejected',
        ...(row.comment == null ? {} : { comment: row.comment }),
        stage: row.stage,
        ...(row.delegated_by == null ? {} : { delegatedBy: row.delegated_by }),
        createdAt: asDate(row.created_at)!,
      }));
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
