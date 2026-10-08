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
  SCHEMA_REVISION: 'weavekit_schema_revision',
  SEQ: 'weavekit_seq',
  AUDIT: 'weavekit_audit',
  AUDIT_OUTBOX: 'weavekit_audit_outbox',
  EVIDENCE: 'weavekit_evidence',
  APPROVALS: 'weavekit_approvals',
  WORKFLOW_DEFINITIONS: 'weavekit_workflow_definitions',
  WORKFLOW_INSTANCES: 'weavekit_workflow_instances',
  WORKFLOW_STEPS: 'weavekit_workflow_steps',
  WORKFLOW_WORKITEMS: 'weavekit_workflow_workitems',
  WORKFLOW_LOCKS: 'weavekit_workflow_locks',
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

const schemaRevision = (): ExpectedTable => ({
  name: SYSTEM_TABLES.SCHEMA_REVISION,
  columns: [
    col('revision', 'BIGSERIAL', { notNull: true, primary: true }),
    col('content_hash', 'TEXT', { notNull: true }),
    col('parent_revision', 'BIGINT'),
    col('source_commit', 'TEXT'),
    col('actor', 'TEXT'),
    col('objects', 'JSONB', { notNull: true }),
    col('status', 'TEXT', { notNull: true, default: "'active'" }),
    col('created_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
  ],
  fks: [],
  indexes: [{ name: 'weavekit_schema_revision_hash_idx', method: 'btree', columns: ['content_hash'] }],
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
    col('request_id', 'TEXT'),
    col('trace_id', 'TEXT'),
    col('tenant_id', 'TEXT'),
    col('meta', 'JSONB'),
  ],
  fks: [],
  indexes: [
    { name: 'weavekit_audit_ts_idx', method: 'btree', columns: ['ts'] },
    { name: 'weavekit_audit_actor_idx', method: 'btree', columns: ['actor_id'] },
    { name: 'weavekit_audit_obj_idx', method: 'btree', columns: ['object', 'object_id'] },
    { name: 'weavekit_audit_request_idx', method: 'btree', columns: ['request_id'] },
    { name: 'weavekit_audit_tenant_idx', method: 'btree', columns: ['tenant_id'] },
  ],
  uniques: [],
});

/**
 * Transactional-outbox for audit (`audit.mode: durable`): a business write
 * inserts an event row in its own transaction; a relay drains it into
 * `weavekit_audit` + the live channel (crash-safe, at-least-once).
 */
const auditOutbox = (): ExpectedTable => ({
  name: SYSTEM_TABLES.AUDIT_OUTBOX,
  columns: [
    col('id', 'BIGSERIAL', { notNull: true, primary: true }),
    col('event', 'JSONB', { notNull: true }),
    col('created_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
  ],
  fks: [],
  indexes: [],
  uniques: [],
});

/**
 * Agent-execution evidence (`evidence.enabled`): one append-only row per gated
 * execution, correlating request/trace/schema revision with the stage timeline.
 * The engine only captures; export/retention belong to the enterprise E2 layer.
 */
const evidence = (): ExpectedTable => ({
  name: SYSTEM_TABLES.EVIDENCE,
  columns: [
    col('id', 'BIGSERIAL', { notNull: true, primary: true }),
    col('ts', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
    col('request_id', 'TEXT'),
    col('trace_id', 'TEXT'),
    col('schema_revision', 'TEXT'),
    col('actor_key', 'TEXT', { notNull: true }),
    col('actor_label', 'TEXT'),
    col('on_behalf_of', 'TEXT'),
    col('subject_id', 'TEXT'),
    col('action', 'TEXT', { notNull: true }),
    col('object', 'TEXT'),
    col('object_id', 'TEXT'),
    col('plan', 'JSONB', { notNull: true }),
    col('stages', 'JSONB', { notNull: true }),
    col('approval_key', 'TEXT'),
    col('is_error', 'BOOLEAN', { notNull: true, default: 'false' }),
    col('error_code', 'TEXT'),
  ],
  fks: [],
  indexes: [
    { name: 'weavekit_evidence_request_idx', method: 'btree', columns: ['request_id'] },
    { name: 'weavekit_evidence_actor_idx', method: 'btree', columns: ['actor_key'] },
    { name: 'weavekit_evidence_action_idx', method: 'btree', columns: ['action'] },
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

const workflowDefinitions = (): ExpectedTable => ({
  name: SYSTEM_TABLES.WORKFLOW_DEFINITIONS,
  columns: [
    col('object', 'TEXT', { notNull: true, primary: true }),
    col('hash', 'TEXT', { notNull: true, primary: true }),
    col('version_seq', 'INTEGER', { notNull: true }),
    col('definition', 'JSONB', { notNull: true }),
    col('created_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
  ],
  fks: [],
  indexes: [],
  uniques: [{ name: 'weavekit_workflow_definitions_object_seq_key', columns: ['object', 'version_seq'] }],
});

const workflowInstances = (): ExpectedTable => ({
  name: SYSTEM_TABLES.WORKFLOW_INSTANCES,
  columns: [
    col('object', 'TEXT', { notNull: true, primary: true }),
    col('record_key', 'TEXT', { notNull: true, primary: true }),
    col('workflow_hash', 'TEXT', { notNull: true }),
    col('state', 'TEXT', { notNull: true }),
    col('current_step_id', 'UUID'),
    col('originator', 'TEXT', { notNull: true }),
    col('originator_parent', 'TEXT'),
    col('approval', 'TEXT'),
    col('created_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
    col('started_at', 'TIMESTAMPTZ'),
    col('activated_at', 'TIMESTAMPTZ'),
    col('finished_at', 'TIMESTAMPTZ'),
  ],
  fks: [],
  indexes: [],
  uniques: [],
});

const workflowSteps = (): ExpectedTable => ({
  name: SYSTEM_TABLES.WORKFLOW_STEPS,
  columns: [
    col('id', 'UUID', { notNull: true, primary: true }),
    col('object', 'TEXT', { notNull: true }),
    col('record_key', 'TEXT', { notNull: true }),
    col('node_id', 'TEXT', { notNull: true }),
    col('kind', 'TEXT', { notNull: true }),
    col('ordinal', 'INTEGER', { notNull: true }),
    col('state', 'TEXT', { notNull: true }),
    col('approval', 'TEXT'),
    col('prev_step_id', 'UUID'),
    col('entered_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
    col('finished_at', 'TIMESTAMPTZ'),
  ],
  fks: [],
  indexes: [
    { name: 'weavekit_workflow_steps_record_idx', method: 'btree', columns: ['object', 'record_key', 'ordinal'] },
  ],
  uniques: [],
});

const workflowWorkitems = (): ExpectedTable => ({
  name: SYSTEM_TABLES.WORKFLOW_WORKITEMS,
  columns: [
    col('id', 'UUID', { notNull: true, primary: true }),
    col('object', 'TEXT', { notNull: true }),
    col('record_key', 'TEXT', { notNull: true }),
    col('step_id', 'UUID', { notNull: true }),
    col('node_id', 'TEXT', { notNull: true }),
    col('kind', 'TEXT', { notNull: true }),
    col('participant', 'TEXT', { notNull: true }),
    col('state', 'TEXT', { notNull: true }),
    col('approval', 'TEXT'),
    col('action', 'TEXT'),
    col('finisher', 'TEXT'),
    col('delegant', 'TEXT'),
    col('receiptor', 'TEXT'),
    col('comment', 'TEXT'),
    col('received_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
    col('started_at', 'TIMESTAMPTZ'),
    col('finished_at', 'TIMESTAMPTZ'),
    col('allowed_at', 'TIMESTAMPTZ'),
  ],
  fks: [],
  indexes: [
    { name: 'weavekit_workflow_workitems_todo_idx', method: 'btree', columns: ['participant', 'state', 'kind'] },
    { name: 'weavekit_workflow_workitems_step_idx', method: 'btree', columns: ['step_id', 'state'] },
    { name: 'weavekit_workflow_workitems_record_idx', method: 'btree', columns: ['object', 'record_key'] },
  ],
  uniques: [],
});

const workflowLocks = (): ExpectedTable => ({
  name: SYSTEM_TABLES.WORKFLOW_LOCKS,
  columns: [
    col('workitem_id', 'UUID', { notNull: true, primary: true }),
    col('object', 'TEXT', { notNull: true }),
    col('record_key', 'TEXT', { notNull: true }),
    col('holder', 'TEXT', { notNull: true }),
    col('acquired_at', 'TIMESTAMPTZ', { notNull: true, default: 'now()' }),
    col('expires_at', 'TIMESTAMPTZ', { notNull: true }),
  ],
  fks: [],
  indexes: [{ name: 'weavekit_workflow_locks_expiry_idx', method: 'btree', columns: ['expires_at'] }],
  uniques: [],
});

const workflowTimers = (): ExpectedTable => ({
  name: SYSTEM_TABLES.WORKFLOW_TIMERS,
  columns: [
    col('object', 'TEXT', { notNull: true, primary: true }),
    col('record_key', 'TEXT', { notNull: true, primary: true }),
    col('node_id', 'TEXT', { notNull: true }),
    col('due_at', 'TIMESTAMPTZ', { notNull: true }),
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
  return [
    meta(),
    metadata(),
    schemaRevision(),
    seq(),
    audit(),
    auditOutbox(),
    evidence(),
    approvals(),
    workflowDefinitions(),
    workflowInstances(),
    workflowSteps(),
    workflowWorkitems(),
    workflowLocks(),
    workflowTimers(),
    counters(),
  ];
}

/**
 * ACL hardening for system tables (run by `migrate`, idempotent). The audit
 * trail is append-only: non-owners must not be able to erase history.
 * (`DROP` is ownership-only in PostgreSQL; `TRUNCATE` is the grantable risk.)
 */
export function systemHardeningStatements(): string[] {
  return [`REVOKE TRUNCATE ON ${SYSTEM_TABLES.AUDIT} FROM PUBLIC;`];
}
