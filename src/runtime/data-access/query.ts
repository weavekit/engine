import type { PoolClient } from 'pg';
import type { ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import { SchemaError, primaryKeyOf, type Locale } from '../../core/index.js';
import { DETAILS_COLUMNS, FIELD_TYPES } from '../../core/index.js';
import type { AuditEvent, AuditSink } from '../../core/audit/index.js';
import { AUDIT_ACTOR_TYPES, DATA_ACTIONS } from '../../core/audit/index.js';
import type { EventPublisher } from '../../core/provider/event/index.js';
import { NOOP_SCRIPT_DISPATCHER, SCRIPT_HOOKS, type GuardrailContext, type GuardrailPolicy, type ScriptDispatcher, type ScriptHook, type ScriptUser, type ToolDataAccess } from '../../core/index.js';
import { evaluateTransition, type PolicyApprovals } from '../tools/policies.js';
import { buildCountSql, buildFindSql, scopeSuffix, type BuildContext } from './builder.js';
import { deleteDetailsChildren, insertDetails } from './details.js';
import { computeFormulas } from './formula.js';
import { ensureSeqTable, generateSeqNo } from './seqno.js';
import type { DataAccessContext, FindOptions, FindResult, ObjectDataAccess } from './types.js';
import { validateRecord } from './validate.js';
import { WRITE_MODES } from './values.js';

const q = (id: string) => `"${id}"`;

/** pg QueryResult shape the drift wrapper needs */
interface QueryResultLike {
  rows: unknown[];
  rowCount?: number | null;
}

/** PG error 42703 = undefined_column: a query referenced a column that doesn't exist */
function isUndefinedColumn(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42703';
}

/** parse `column "X" of relation "Y" does not exist` → the column/field name */
function undefinedColumnOf(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return undefined;
  const m = /column "([^"]+)" of relation/.exec(message);
  return m?.[1];
}

/** PG error 23505 = unique_violation: a unique constraint (column or object constraint) was hit */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/** readable field list behind a unique violation (from the detail `Key (a, b)=(...)`) */
function uniqueFieldsOf(error: unknown): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') {
    const m = /Key \(([^)]+)\)/.exec(detail);
    if (m?.[1] !== undefined) return m[1];
  }
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  return typeof constraint === 'string' ? constraint : '?';
}

/**
 * Run a SQL statement against an object's table, mapping PG `undefined_column`
 * (42703) — a schema/DB drift (schema declares a field the table lacks) — to an
 * actionable error instead of a raw 500.
 */
async function runTableQuery(
  q: { query(sql: string, params: unknown[]): Promise<QueryResultLike> },
  objectName: string,
  sql: string,
  params: unknown[],
  locale?: Locale,
): Promise<QueryResultLike> {
  try {
    return await q.query(sql, params);
  } catch (error) {
    if (isUndefinedColumn(error)) {
      const field = undefinedColumnOf(error);
      throw new SchemaError('data.schemaDrift', { object: objectName, field: field ?? '' }, locale);
    }
    if (isUniqueViolation(error)) {
      throw new SchemaError('data.unique', { object: objectName, fields: uniqueFieldsOf(error) }, locale);
    }
    throw error;
  }
}

/** emit a write-audit event (fire-and-forget — audit never blocks the business path) */
function auditWrite(
  sink: AuditSink | undefined,
  ctx: DataAccessContext,
  action: string,
  objectName: string,
  objectId: string | undefined,
  changes: unknown,
  error?: unknown,
  before?: unknown,
  after?: unknown,
): void {
  if (sink === undefined) return;
  const event: AuditEvent = {
    actorType: ctx.subject !== undefined ? AUDIT_ACTOR_TYPES.USER : AUDIT_ACTOR_TYPES.SYSTEM,
    actorId: ctx.subject?.id ?? 'system',
    action,
    objectName,
    objectId,
    changes,
    isError: error !== undefined,
    errorCode: error instanceof SchemaError ? error.code : undefined,
    timestamp: new Date(),
  };
  if (before !== undefined) event.before = before;
  if (after !== undefined) event.after = after;
  void sink.record(event);
}

/** rebuild `this.user` for hooks from the authenticated subject */
function scriptUserOf(ctx: DataAccessContext): ScriptUser {
  return {
    id: ctx.subject?.id ?? 'system',
    roles: ctx.subject?.roles ?? [],
    teamId: ctx.subject?.teamId,
  };
}

const PARENT_COLUMNS = new Set<string>([
  DETAILS_COLUMNS.PARENT_ID,
  DETAILS_COLUMNS.PARENT_TYPE,
  DETAILS_COLUMNS.PARENT_IDX,
]);

function isDetailsChild(registry: ObjectRegistry, name: string): boolean {
  return registry
    .list()
    .some((o) => o.fields.some((f) => f.type === FIELD_TYPES.DETAILS && f.target === name));
}

function requireDef(ctx: DataAccessContext, objectName: string): ObjectDefinition {
  const def = ctx.registry.get(objectName);
  if (def === undefined) throw new SchemaError('data.objectUnknown', { object: objectName }, ctx.locale);
  return def;
}

function bctx(ctx: DataAccessContext, objectName: string): BuildContext {
  return { object: objectName, locale: ctx.locale, allowParentCols: isDetailsChild(ctx.registry, objectName) };
}

/**
 * Narrow `ToolDataAccess` over this data-access for guardrail policies: a policy
 * calls `ctx.dataAccess.find(obj, opts, { subject? })` with no pool/registry, so
 * those are injected from the execution context (mirrors the tool executor's
 * wrapper; `...c` lets a policy override the subject per call).
 */
function toolDataAccessOver(inner: ObjectDataAccess, base: DataAccessContext): ToolDataAccess {
  return {
    find: (n, o, c) => inner.find(n, o as unknown as FindOptions, { ...base, ...c }),
    findOne: (n, id, c) => inner.findOne(n, id, { ...base, ...c }),
    create: (n, d, c) => inner.create(n, d, { ...base, ...c }),
    update: (n, id, changes, c) => inner.update(n, id, changes, { ...base, ...c }),
    delete: (n, id, c) => inner.delete(n, id, { ...base, ...c }),
  } as ToolDataAccess;
}

/**
 * Serialize a value for binding to a DB column. pg (node-postgres) auto-stringifies
 * JSON *objects* but serializes JSON *arrays* as a PG array literal (`{"a"}`) which
 * is invalid as `json` — so we explicitly `JSON.stringify` non-string json values
 * (arrays/objects/numbers/booleans) to valid JSON text. `null` stays SQL NULL.
 */
function dbJsonValue(field: { type?: string } | undefined, value: unknown): unknown {
  if (field !== undefined && field.type === FIELD_TYPES.JSON && value !== null && typeof value !== 'string') {
    return JSON.stringify(value);
  }
  return value;
}

/** controlled object data-access implementation (PG-backed) */
export class DefaultObjectDataAccess implements ObjectDataAccess {
  private readonly audit?: AuditSink;
  private readonly script: ScriptDispatcher;
  /** audit diff replay: attach before/after row snapshots to update/delete audit events */
  private readonly replay: boolean;
  /** live events: publish committed writes to the bus (undefined = zero overhead) */
  private readonly events?: EventPublisher;
  /** objects currently dispatching onLoad — skips re-entrant onLoad (a hook re-reading the same object) */
  private readonly onLoadInFlight = new Set<string>();
  /** guardrail policies shared with the open-contract (empty = no policy gate on transitions) */
  private readonly policies: readonly GuardrailPolicy[];
  /** approval queue used when a policy or a transition requires approval */
  private readonly approvals?: PolicyApprovals;

  constructor(
    options: {
      audit?: AuditSink;
      script?: ScriptDispatcher;
      replay?: boolean;
      events?: EventPublisher;
      policies?: readonly GuardrailPolicy[];
      approvals?: PolicyApprovals;
    } = {},
  ) {
    this.audit = options.audit;
    this.script = options.script ?? NOOP_SCRIPT_DISPATCHER;
    this.replay = options.replay ?? false;
    this.events = options.events;
    this.policies = options.policies ?? [];
    this.approvals = options.approvals;
  }

  /**
   * Run the read hook (`onLoad`) over a fetched batch. The hook receives the
   * whole batch as `this.records` and returns an **equal-length** array (or
   * undefined/null to keep the batch unchanged). A length mismatch is an error
   * (fail-closed: never silently drop rows — `total` stays the DB count).
   * Re-entrant onLoad for the same object is skipped to avoid recursion.
   */
  private async runOnLoad(
    objectName: string,
    records: Record<string, unknown>[],
    ctx: DataAccessContext,
  ): Promise<Record<string, unknown>[]> {
    if (records.length === 0 || !this.script.has(objectName, SCRIPT_HOOKS.ON_LOAD)) return records;
    if (this.onLoadInFlight.has(objectName)) return records;
    this.onLoadInFlight.add(objectName);
    try {
      const result = await this.script.dispatch(objectName, SCRIPT_HOOKS.ON_LOAD, {
        records,
        record: null,
        changes: {},
        user: scriptUserOf(ctx),
      });
      if (result.records === undefined) return records;
      if (result.records.length !== records.length) {
        throw new SchemaError(
          'script.abort',
          { hook: 'onLoad', message: `onLoad returned ${result.records.length} records, expected ${records.length}` },
          ctx.locale,
        );
      }
      return result.records;
    } finally {
      this.onLoadInFlight.delete(objectName);
    }
  }

  /**
   * Run a before-write hook (validate/beforeUpdate/beforeDelete). Throws on
   * hook failure → the surrounding transaction rolls back. Returns the
   * possibly-modified changes from beforeUpdate (undefined = keep original).
   */
  private async runBeforeHook(
    hook: ScriptHook,
    objectName: string,
    record: Record<string, unknown> | null,
    changes: Record<string, unknown>,
    ctx: DataAccessContext,
    extra?: { transition?: { from: string; to: string; label?: string } | null; state?: string | null },
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.script.has(objectName, hook)) return undefined;
    const result = await this.script.dispatch(objectName, hook, {
      record,
      changes,
      user: scriptUserOf(ctx),
      ...(extra ?? {}),
    });
    return result.changes;
  }

  /**
   * Run an after-write hook (afterUpdate/afterDelete) — the write is already
   * committed, so a hook failure is a non-fatal warning: recorded to audit and
   * delivered via `ctx.onWarnings`, never rethrown.
   */
  private async runAfterHook(
    hook: ScriptHook,
    action: string,
    objectName: string,
    record: Record<string, unknown> | null,
    changes: Record<string, unknown>,
    ctx: DataAccessContext,
    warnings: string[],
    objectId: string,
    extra?: { transition?: { from: string; to: string; label?: string } | null; state?: string | null },
  ): Promise<void> {
    if (!this.script.has(objectName, hook)) return;
    try {
      await this.script.dispatch(objectName, hook, {
        record,
        changes,
        user: scriptUserOf(ctx),
        ...(extra ?? {}),
      });
    } catch (error) {
      // surface the hook's own message (SchemaError(script.abort) wraps it)
      const message =
        error instanceof SchemaError && typeof error.params.message === 'string'
          ? error.params.message
          : error instanceof Error
            ? error.message
            : String(error);
      warnings.push(message);
      auditWrite(this.audit, ctx, action, objectName, objectId, changes, error);
    }
  }

  async find<T = Record<string, unknown>>(
    objectName: string,
    opts: FindOptions,
    ctx: DataAccessContext,
  ): Promise<FindResult<T>> {
    const def = requireDef(ctx, objectName);
    const q = ctx.client ?? ctx.pool;
    const { sql, params } = buildFindSql(def, opts, bctx(ctx, objectName), ctx.rowScope, opts.exclude);
    const { rows } = await runTableQuery(q, objectName, sql, params, ctx.locale);
    const { sql: countSql, params: countParams } = buildCountSql(def, opts, bctx(ctx, objectName), ctx.rowScope);
    const { rows: countRows } = await runTableQuery(q, objectName, countSql, countParams, ctx.locale);
    const loaded = await this.runOnLoad(objectName, rows as Record<string, unknown>[], ctx);
    return { rows: loaded as T[], total: (countRows[0] as { total: number }).total };
  }

  async findOne<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    ctx: DataAccessContext,
  ): Promise<T | null> {
    const def = requireDef(ctx, objectName);
    const pk = primaryKeyOf(def);
    if (pk === undefined) {
      throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
    }
    const result = await this.find<T>(objectName, { filter: { [pk]: id }, limit: 1 }, ctx);
    return result.rows[0] ?? null;
  }

  async create<T = Record<string, unknown>>(
    objectName: string,
    data: Record<string, unknown>,
    ctx: DataAccessContext,
  ): Promise<T> {
    const def = requireDef(ctx, objectName);
    const pk = primaryKeyOf(def);
    if (pk === undefined) {
      throw new SchemaError('data.recordNotFound', { object: objectName }, ctx.locale);
    }
    let client: PoolClient;
    let owned = false;
    if (ctx.client !== undefined) {
      client = ctx.client;
    } else {
      owned = true;
      client = await ctx.pool.connect();
    }
    const warnings: string[] = [];
    try {
      if (owned) await client.query('BEGIN');
      await validateRecord(def, data, WRITE_MODES.CREATE, { pool: client, registry: ctx.registry, locale: ctx.locale });

      // validate → beforeUpdate (may rewrite the payload); both abort on throw
      await this.runBeforeHook(SCRIPT_HOOKS.VALIDATE, objectName, null, data, ctx);
      let payload = data;
      const before = await this.runBeforeHook(SCRIPT_HOOKS.BEFORE_UPDATE, objectName, null, data, ctx);
      if (before !== undefined) payload = before;

      const now = new Date();
      const record: Record<string, unknown> = {};

      // apply schema defaults for missing fields
      for (const field of def.fields) {
        if (field.type === FIELD_TYPES.DETAILS) continue;
        const raw = field as { default?: unknown };
        if (raw.default === undefined) continue;
        if (payload[field.name] !== undefined) continue;
        record[field.name] =
          (field.type === FIELD_TYPES.DATETIME || field.type === FIELD_TYPES.DATE) && raw.default === 'now'
            ? now.toISOString()
            : raw.default;
      }
      Object.assign(record, payload);

      // workflow-managed state: new records always start in the declared initial
      // state (engine-managed — a hook cannot seed a different state)
      if (def.workflow !== undefined) {
        record[def.workflow.stateField] = def.workflow.initial;
      }

      const seqFields = def.fields.filter((f) => f.type === FIELD_TYPES.SEQ_NO);
      if (seqFields.length > 0) {
        await ensureSeqTable(client);
        for (const f of seqFields) record[f.name] = await generateSeqNo(client, def.name, f, now);
      }

      const child = isDetailsChild(ctx.registry, def.name);
      if (child && record[DETAILS_COLUMNS.PARENT_ID] !== undefined && record[DETAILS_COLUMNS.PARENT_IDX] === undefined) {
        const res = await runTableQuery(
          client,
          def.name,
          `SELECT COALESCE(MAX(${q(DETAILS_COLUMNS.PARENT_IDX)}), 0) + 1 AS n FROM ${q(def.name)}
           WHERE ${q(DETAILS_COLUMNS.PARENT_ID)} = $1 AND ${q(DETAILS_COLUMNS.PARENT_TYPE)} = $2`,
          [record[DETAILS_COLUMNS.PARENT_ID], record[DETAILS_COLUMNS.PARENT_TYPE]],
          ctx.locale,
        );
        record[DETAILS_COLUMNS.PARENT_IDX] = (res.rows[0] as { n: number }).n;
      }

      const cols = [
        ...def.fields.filter((f) => f.type !== FIELD_TYPES.DETAILS).map((f) => f.name),
        ...(child ? [...PARENT_COLUMNS] : []),
      ];
      const fieldByName = new Map(def.fields.map((f) => [f.name, f]));
      const values = cols.map((c) => dbJsonValue(fieldByName.get(c), record[c] ?? null));
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await runTableQuery(
        client,
        def.name,
        `INSERT INTO ${q(def.name)} (${cols.map(q).join(', ')}) VALUES (${placeholders})`,
        values,
        ctx.locale,
      );

      await insertDetails(client, def, record[pk], payload, ctx.registry, ctx.locale);

      // compute formula fields AFTER children exist (aggregates see them), then persist
      await computeFormulas(def, record, client, ctx.registry, now);
      const formulaCols = def.fields
        .filter((f) => (f as { formula?: string }).formula !== undefined)
        .map((f) => f.name);
      if (formulaCols.length > 0) {
        const setSql = formulaCols.map((c, i) => `${q(c)} = $${i + 1}`).join(', ');
        const formulaValues = formulaCols.map((c) => record[c] ?? null);
        await runTableQuery(
          client,
          def.name,
          `UPDATE ${q(def.name)} SET ${setSql} WHERE ${q(pk)} = $${formulaCols.length + 1}`,
          [...formulaValues, record[pk]],
          ctx.locale,
        );
      }

      if (owned) await client.query('COMMIT');
      auditWrite(this.audit, ctx, DATA_ACTIONS.CREATE, objectName, String(record[pk] ?? ''), record);
      this.events?.publishRecordChange('created', objectName, String(record[pk] ?? ''));
      await this.runAfterHook(SCRIPT_HOOKS.AFTER_UPDATE, DATA_ACTIONS.CREATE, objectName, record, payload, ctx, warnings, String(record[pk] ?? ''));
      if (warnings.length > 0) ctx.onWarnings?.(warnings);
      const loaded = await this.runOnLoad(objectName, [record], ctx);
      return loaded[0] as T;
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      auditWrite(this.audit, ctx, DATA_ACTIONS.CREATE, objectName, data[pk] === undefined ? undefined : String(data[pk]), data, err);
      throw err;
    } finally {
      if (owned) client.release();
    }
  }

  async update<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    changes: Record<string, unknown>,
    ctx: DataAccessContext,
  ): Promise<T> {
    const def = requireDef(ctx, objectName);
    const pk = primaryKeyOf(def);
    if (pk === undefined) {
      throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
    }
    let client: PoolClient;
    let owned = false;
    if (ctx.client !== undefined) {
      client = ctx.client;
    } else {
      owned = true;
      client = await ctx.pool.connect();
    }
    const warnings: string[] = [];
    try {
      if (owned) await client.query('BEGIN');
      await validateRecord(def, changes, WRITE_MODES.UPDATE, { pool: client, registry: ctx.registry, locale: ctx.locale });

      const { sql, params } = buildFindSql(def, { filter: { [pk]: id }, limit: 1 }, bctx(ctx, objectName), ctx.rowScope);
      const { rows } = await runTableQuery(client, objectName, sql, params, ctx.locale);
      const existing = rows[0] as Record<string, unknown> | undefined;
      if (existing === undefined) {
        throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      }

      // validate → beforeUpdate; hooks see the pre-update record and may rewrite changes
      await this.runBeforeHook(SCRIPT_HOOKS.VALIDATE, objectName, existing, changes, ctx);
      let payload = changes;
      const before = await this.runBeforeHook(SCRIPT_HOOKS.BEFORE_UPDATE, objectName, existing, changes, ctx);
      if (before !== undefined) payload = before;

      // the workflow state is transition-only: a beforeUpdate hook may not move it
      if (
        def.workflow !== undefined &&
        payload[def.workflow.stateField] !== undefined &&
        payload[def.workflow.stateField] !== existing[def.workflow.stateField]
      ) {
        throw new SchemaError('workflow.transition.required', { object: objectName, field: def.workflow.stateField }, ctx.locale);
      }

      const now = new Date();
      const record = { ...existing, ...payload };
      await computeFormulas(def, record, client, ctx.registry, now);

      const settable = new Set<string>();
      for (const key of Object.keys(payload)) {
        if (isDetailsChild(ctx.registry, def.name) && PARENT_COLUMNS.has(key)) {
          settable.add(key);
          continue;
        }
        const field = def.fields.find((f) => f.name === key);
        if (field !== undefined && field.type !== FIELD_TYPES.DETAILS) settable.add(key);
      }
      for (const field of def.fields) {
        if ((field as { formula?: string }).formula !== undefined) settable.add(field.name);
      }
      settable.delete(pk);

      if (settable.size > 0) {
        const cols = [...settable];
        const setSql = cols.map((c, i) => `${q(c)} = $${i + 1}`).join(', ');
        const scope = ctx.rowScope !== undefined ? scopeSuffix(ctx.rowScope, cols.length + 1) : undefined;
        const values = cols.map((c) => dbJsonValue(def.fields.find((f) => f.name === c), record[c] ?? null));
        await runTableQuery(
          client,
          objectName,
          `UPDATE ${q(def.name)} SET ${setSql} WHERE ${q(pk)} = $${cols.length + 1}${scope !== undefined ? ` AND (${scope.sql})` : ''}`,
          [...values, id, ...(scope?.params ?? [])],
          ctx.locale,
        );
      }

      if (owned) await client.query('COMMIT');
      auditWrite(this.audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, payload, undefined, this.replay ? existing : undefined, this.replay ? record : undefined);
      this.events?.publishRecordChange('updated', objectName, id);
      await this.runAfterHook(SCRIPT_HOOKS.AFTER_UPDATE, DATA_ACTIONS.UPDATE, objectName, record, payload, ctx, warnings, id);
      if (warnings.length > 0) ctx.onWarnings?.(warnings);
      const loaded = await this.runOnLoad(objectName, [record], ctx);
      return loaded[0] as T;
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      auditWrite(this.audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, changes, err);
      throw err;
    } finally {
      if (owned) client.release();
    }
  }

  /**
   * Fire a declared workflow transition: read the current state, resolve the
   * transition for `(from, action)`, run the before-hook, write the target state
   * (plus any hook-returned changes) guarded by an optimistic `WHERE state = from`,
   * then run the after/onExit/onEnter hooks. The state field is otherwise
   * read-only, so this is the only path that moves a record between states.
   */
  async transition<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    action: string,
    ctx: DataAccessContext,
  ): Promise<T> {
    const def = requireDef(ctx, objectName);
    const wf = def.workflow;
    if (wf === undefined) {
      throw new SchemaError('workflow.transition.unknown', { object: objectName, action }, ctx.locale);
    }
    const pk = primaryKeyOf(def);
    if (pk === undefined) {
      throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
    }
    let client: PoolClient;
    let owned = false;
    if (ctx.client !== undefined) {
      client = ctx.client;
    } else {
      owned = true;
      client = await ctx.pool.connect();
    }
    const warnings: string[] = [];
    try {
      if (owned) await client.query('BEGIN');
      const { sql, params } = buildFindSql(def, { filter: { [pk]: id }, limit: 1 }, bctx(ctx, objectName), ctx.rowScope);
      const { rows } = await runTableQuery(client, objectName, sql, params, ctx.locale);
      const existing = rows[0] as Record<string, unknown> | undefined;
      if (existing === undefined) {
        throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      }

      const rawState = existing[wf.stateField];
      const currentState = typeof rawState === 'string' ? rawState : String(rawState ?? '');
      const transition = wf.transitions.find((t) => t.action === action && t.from === currentState);
      if (transition === undefined) {
        const known = wf.transitions.some((t) => t.action === action);
        throw new SchemaError(
          known ? 'workflow.transition.notAllowed' : 'workflow.transition.unknown',
          { object: objectName, action, from: currentState },
          ctx.locale,
        );
      }
      const subject = ctx.subject;
      if (transition.roles !== undefined && subject !== undefined) {
        if (!transition.roles.some((role) => subject.roles.includes(role))) {
          throw new SchemaError(
            'workflow.transition.denied',
            { object: objectName, role: subject.roles.join(','), action },
            ctx.locale,
          );
        }
      }

      // guardrail policy gate + optional approval (shared policy set with the open-contract)
      if (this.policies.length > 0 || transition.requiresApproval === true) {
        const actorId = subject?.id ?? 'system';
        const guardrailCtx: GuardrailContext = {
          actor: { key: actorId, label: actorId, onBehalfOf: actorId },
          subject: subject ?? { id: 'system', roles: [] },
          action: `workflow.transition.${def.name}.${action}`,
          args: { object: def.name, id, action, from: transition.from, to: transition.to },
          dataAccess: toolDataAccessOver(this, {
            pool: ctx.pool,
            registry: ctx.registry,
            ...(ctx.locale === undefined ? {} : { locale: ctx.locale }),
            ...(ctx.client === undefined ? {} : { client: ctx.client }),
            ...(subject === undefined ? {} : { subject }),
          }),
        };
        const gate = await evaluateTransition(
          this.policies,
          this.approvals,
          guardrailCtx,
          transition.requiresApproval === true,
        );
        if (gate.kind === 'deny') {
          throw new SchemaError(
            gate.code,
            { object: objectName, action, reason: gate.reason ?? '' },
            ctx.locale,
          );
        }
        if (gate.kind === 'pending') {
          throw new SchemaError(
            'workflow.transition.pending',
            { object: objectName, action, approvalKey: gate.approvalKey },
            ctx.locale,
          );
        }
      }

      const transitionInfo = { from: transition.from, to: transition.to };
      const before = await this.runBeforeHook(
        SCRIPT_HOOKS.BEFORE_TRANSITION,
        objectName,
        existing,
        { [wf.stateField]: transition.to },
        ctx,
        { transition: transitionInfo, state: transition.to },
      );
      const payload: Record<string, unknown> = {
        ...(before ?? {}),
        [wf.stateField]: transition.to,
      };

      const now = new Date();
      const record = { ...existing, ...payload };
      await computeFormulas(def, record, client, ctx.registry, now);

      const settable = new Set<string>();
      for (const key of Object.keys(payload)) {
        const field = def.fields.find((f) => f.name === key);
        if (field !== undefined && field.type !== FIELD_TYPES.DETAILS) settable.add(key);
      }
      for (const field of def.fields) {
        if ((field as { formula?: string }).formula !== undefined) settable.add(field.name);
      }
      settable.delete(pk);
      settable.add(wf.stateField);

      const cols = [...settable];
      const setSql = cols.map((c, i) => `${q(c)} = $${i + 1}`).join(', ');
      const values = cols.map((c) => dbJsonValue(def.fields.find((f) => f.name === c), record[c] ?? null));
      const scope = ctx.rowScope !== undefined ? scopeSuffix(ctx.rowScope, cols.length + 3) : undefined;
      const res = await runTableQuery(
        client,
        objectName,
        `UPDATE ${q(def.name)} SET ${setSql} WHERE ${q(pk)} = $${cols.length + 1} AND ${q(wf.stateField)} = $${cols.length + 2}${scope !== undefined ? ` AND (${scope.sql})` : ''}`,
        [...values, id, currentState, ...(scope?.params ?? [])],
        ctx.locale,
      );
      if (res.rowCount === 0) {
        throw new SchemaError(
          'http.conflict',
          { detail: `record "${id}" changed state during the transition` },
          ctx.locale,
        );
      }

      if (owned) await client.query('COMMIT');
      const updated = record;
      auditWrite(
        this.audit,
        ctx,
        DATA_ACTIONS.TRANSITION,
        objectName,
        id,
        { transition: action, from: transition.from, to: transition.to, changes: payload },
        undefined,
        this.replay ? existing : undefined,
        this.replay ? updated : undefined,
      );
      this.events?.publishRecordChange('updated', objectName, id);
      this.events?.publishRecordTransitioned(objectName, id, transition.from, transition.to, action);
      await this.runAfterHook(SCRIPT_HOOKS.ON_EXIT, DATA_ACTIONS.TRANSITION, objectName, existing, {}, ctx, warnings, id, {
        transition: transitionInfo,
        state: transition.from,
      });
      await this.runAfterHook(SCRIPT_HOOKS.ON_ENTER, DATA_ACTIONS.TRANSITION, objectName, updated, payload, ctx, warnings, id, {
        transition: transitionInfo,
        state: transition.to,
      });
      await this.runAfterHook(SCRIPT_HOOKS.AFTER_TRANSITION, DATA_ACTIONS.TRANSITION, objectName, updated, payload, ctx, warnings, id, {
        transition: transitionInfo,
        state: transition.to,
      });
      if (warnings.length > 0) ctx.onWarnings?.(warnings);
      const loaded = await this.runOnLoad(objectName, [updated], ctx);
      return loaded[0] as T;
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      auditWrite(this.audit, ctx, DATA_ACTIONS.TRANSITION, objectName, id, { transition: action }, err);
      throw err;
    } finally {
      if (owned) client.release();
    }
  }

  async delete(objectName: string, id: string, ctx: DataAccessContext): Promise<void> {
    const def = requireDef(ctx, objectName);
    const pk = primaryKeyOf(def);
    if (pk === undefined) {
      throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
    }
    let client: PoolClient;
    let owned = false;
    if (ctx.client !== undefined) {
      client = ctx.client;
    } else {
      owned = true;
      client = await ctx.pool.connect();
    }
    const warnings: string[] = [];
    try {
      if (owned) await client.query('BEGIN');
      const { sql, params } = buildFindSql(def, { filter: { [pk]: id }, limit: 1 }, bctx(ctx, objectName), ctx.rowScope);
      const { rows } = await runTableQuery(client, objectName, sql, params, ctx.locale);
      const existing = rows[0] as Record<string, unknown> | undefined;
      if (existing === undefined) {
        throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      }

      await this.runBeforeHook(SCRIPT_HOOKS.BEFORE_DELETE, objectName, existing, {}, ctx);
      await deleteDetailsChildren(client, def, id, ctx.registry);
      const scope = ctx.rowScope !== undefined ? scopeSuffix(ctx.rowScope, 1) : undefined;
      const res = await runTableQuery(
        client,
        objectName,
        `DELETE FROM ${q(def.name)} WHERE ${q(pk)} = $1${scope !== undefined ? ` AND (${scope.sql})` : ''}`,
        [id, ...(scope?.params ?? [])],
        ctx.locale,
      );
      if (res.rowCount === 0) throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      if (owned) await client.query('COMMIT');
      auditWrite(this.audit, ctx, DATA_ACTIONS.DELETE, objectName, id, undefined, undefined, this.replay ? existing : undefined);
      this.events?.publishRecordChange('deleted', objectName, id);
      await this.runAfterHook(SCRIPT_HOOKS.AFTER_DELETE, DATA_ACTIONS.DELETE, objectName, existing, {}, ctx, warnings, id);
      if (warnings.length > 0) ctx.onWarnings?.(warnings);
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      auditWrite(this.audit, ctx, DATA_ACTIONS.DELETE, objectName, id, undefined, err);
      throw err;
    } finally {
      if (owned) client.release();
    }
  }
}

export function createDataAccess(
  options: {
    audit?: AuditSink;
    script?: ScriptDispatcher;
    replay?: boolean;
    events?: EventPublisher;
    policies?: readonly GuardrailPolicy[];
    approvals?: PolicyApprovals;
  } = {},
): ObjectDataAccess {
  return new DefaultObjectDataAccess(options);
}
