import type { ExpectedColumn, ExpectedTable } from './diff.js';

/**
 * Engine-owned **system tables**.
 *
 * These are the engine's own bookkeeping tables (metadata cache, sequence
 * counters, audit trail, approval queue, workflow timers, quota counters) plus
 * the migration meta table. They are created **only by `weave migrate`** — the
 * runtime never emits DDL, so the runtime database account can be
 * least-privileged (no `CREATE`). `migrate` diffs them like any other table
 * (idempotent, additive-only on existing tables).
 *
 * All tables live in the connection's `current_schema()`, alongside customer
 * tables; they are never declared in a project's `objects/` tree.
 */

/** canonical names of the engine system tables (single source for docs/tests) */
export const SYSTEM_TABLES = {
  META: 'weavekit_meta',
  METADATA: 'weavekit_metadata',
  SEQ: 'weavekit_seq',
  AUDIT: 'weavekit_audit',
  APPROVALS: 'weavekit_approvals',
  WORKFLOW_TIMERS: 'weavekit_workflow_timers',
  COUNTERS: 'weavekit_counters',
} as const;

/** all system table names, in a stable order */
export const SYSTEM_TABLE_NAMES: readonly string[] = Object.values(SYSTEM_TABLES);

function col(
  name: string,
  type: string,
  opts: Partial<Pick<ExpectedColumn, 'notNull' | 'default' | 'primary' | 'unique'>> = {},
): ExpectedColumn {
  return {
    name,
    type,
    notNull: opts.notNull ?? false,
    default: opts.default,
    primary: opts.primary ?? false,
    unique: opts.unique ?? false,
  };
}

const meta = (): ExpectedTable => ({
  name: SYSTEM_TABLES.META,
  columns: [col('key', 'TEXT', { notNull: true, primary: true }), col('value', 'TEXT', { notNull: true })],
  fks: [],
  indexes: [],
  uniques: [],
});

const metadata = (): ExpectedTable => ({
  name: SYSTEM_TABLES.METADATA,
  columns: [
    col('object_name', 'TEXT', { notNull: true, primary: true }),
    col('content_hash', 'TEXT', { notNull: true }),
    col('definition', 'JSONB', { notNull: true }),
    col('applied_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
    col('updated_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
  ],
  fks: [],
  indexes: [],
  uniques: [],
});

const seq = (): ExpectedTable => ({
  name: SYSTEM_TABLES.SEQ,
  columns: [
    col('object_name', 'TEXT', { notNull: true, primary: true }),
    col('bucket', 'TEXT', { notNull: true, primary: true }),
    col('last_value', 'BIGINT', { notNull: true }),
  ],
  fks: [],
  indexes: [],
  uniques: [],
});

const audit = (): ExpectedTable => ({
  name: SYSTEM_TABLES.AUDIT,
  columns: [
    col('id', 'BIGSERIAL', { notNull: true, primary: true }),
    col('ts', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
    col('actor_type', 'TEXT', { notNull: true }),
    col('actor_id', 'TEXT', { notNull: true }),
    col('action', 'TEXT', { notNull: true }),
    col('object', 'TEXT'),
    col('object_id', 'TEXT'),
    col('changes', 'JSONB'),
    col('before', 'JSONB'),
    col('after', 'JSONB'),
    col('is_error', 'BOOLEAN', { notNull: true, default: 'false' }),
    col('error_code', 'TEXT'),
    col('meta', 'JSONB'),
  ],
  fks: [],
  indexes: [
    { name: 'weavekit_audit_ts_idx', method: 'btree', columns: ['ts'] },
    { name: 'weavekit_audit_actor_idx', method: 'btree', columns: ['actor_id'] },
    { name: 'weavekit_audit_obj_idx', method: 'btree', columns: ['object', 'object_id'] },
  ],
  uniques: [],
});

const approvals = (): ExpectedTable => ({
  name: SYSTEM_TABLES.APPROVALS,
  columns: [
    col('approval_key', 'TEXT', { notNull: true, primary: true }),
    col('action', 'TEXT', { notNull: true }),
    col('args', 'JSONB', { notNull: true }),
    col('actor_key', 'TEXT', { notNull: true }),
    col('status', 'TEXT', { notNull: true }),
    col('created_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
    col('approved_by', 'TEXT'),
    col('resolved_at', 'TIMESTAMPTZ'),
  ],
  fks: [],
  indexes: [
    { name: 'weavekit_approvals_status_created_idx', method: 'btree', columns: ['status', 'created_at'] },
    { name: 'weavekit_approvals_actor_idx', method: 'btree', columns: ['actor_key'] },
  ],
  uniques: [],
});

const workflowTimers = (): ExpectedTable => ({
  name: SYSTEM_TABLES.WORKFLOW_TIMERS,
  columns: [
    col('object', 'TEXT', { notNull: true, primary: true }),
    col('id', 'TEXT', { notNull: true, primary: true }),
    col('state', 'TEXT', { notNull: true }),
    col('due_at', 'TIMESTAMPTZ', { notNull: true }),
    col('workflow_version', 'INTEGER'),
    col('workflow_hash', 'TEXT'),
  ],
  fks: [],
  indexes: [{ name: 'weavekit_workflow_timers_due_idx', method: 'btree', columns: ['due_at'] }],
  uniques: [],
});

const counters = (): ExpectedTable => ({
  name: SYSTEM_TABLES.COUNTERS,
  columns: [
    col('key', 'TEXT', { notNull: true, primary: true }),
    col('period_start', 'TIMESTAMPTZ', { notNull: true, primary: true }),
    col('value', 'BIGINT', { notNull: true, default: '0' }),
    col('updated_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
  ],
  fks: [],
  indexes: [],
  uniques: [],
});

/**
 * The expected shape of every engine system table. `migrate` diffs this list
 * unconditionally, so a single `weave migrate` provisions everything the
 * runtime needs; the runtime itself never runs DDL.
 */
export function buildSystemTables(): ExpectedTable[] {
  return [meta(), metadata(), seq(), audit(), approvals(), workflowTimers(), counters()];
}

/**
 * ACL hardening for system tables (run by `migrate`, idempotent). The audit
 * trail is append-only: non-owners must not be able to erase history.
 * (`DROP` is ownership-only in PostgreSQL; `TRUNCATE` is the grantable risk.)
 */
export function systemHardeningStatements(): string[] {
  return [`REVOKE TRUNCATE ON ${SYSTEM_TABLES.AUDIT} FROM PUBLIC;`];
}
