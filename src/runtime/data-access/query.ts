import type { Pool, PoolClient } from 'pg';
import type { ObjectDefinition } from '../../core/index.js';
import { SchemaError, METRIC_NAMES, isSafeRlsRole, primaryFieldsOf, principalActorId, type MetricsSink } from '../../core/index.js';
import { DETAILS_COLUMNS, FIELD_TYPES, RECORD_META_ID_FIELD, recordKeySql, recordMetaTableName, scopeFieldName } from '../../core/index.js';
import type { AuditSink } from '../../core/audit/index.js';
import { DATA_ACTIONS } from '../../core/audit/index.js';
import type { EventPublisher } from '../../core/provider/event/index.js';
import { NOOP_SCRIPT_DISPATCHER, SCRIPT_HOOKS, type GuardrailContext, type GuardrailPolicy, type ScriptDispatcher, type ScriptHook, type WorkflowTimerSync } from '../../core/index.js';
import { evaluateTransition, type PolicyApprovals } from '../tools/policies.js';
import { buildCountSql, buildEstimateSql, buildFindSql, resolvePagination, scopeSuffix, type BuildContext } from './builder.js';
import { deleteDetailsChildren, insertDetails } from './details.js';
import { insertLinks, replaceLinks } from './link.js';
import {
  WORKFLOW_ACTIONS,
  runWorkflowTransition,
  getWorkflowStatus,
  acquireWorkflowLock,
  releaseWorkflowLock,
  getWorkflowHistory,
  getWorkflowTodos,
  overrideWorkflow,
  type WorkflowStatus,
  type WorkflowHistory,
  type WorkflowTodo,
  type WorkflowOverride,
} from './workflow.js';
import { computeFormulas } from './formula.js';
import { generateSeqNo } from './seqno.js';
import { subjectOf, scopeOf, type DataAccessContext, type FindOptions, type FindResult, type ObjectDataAccess } from './types.js';
import { validateRecord } from './validate.js';
import { FILTER_OPS, SORT_DIRS, TOTAL_MODES, WRITE_MODES, type TotalMode } from './values.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { QUERY_BUDGET_DEFAULTS, assertQueryBudget, type QueryBudget } from './query-budget.js';
import { EXECUTION_OUTCOMES, type EvidenceSink, type ExecutionPlan, type MessageKey } from '../../core/index.js';
import { runPipeline, type PipelineContext, type PipelineGate } from '../execution/index.js';
import { upsertRecordMeta, deleteRecordMeta } from '../record-meta/index.js';
import { SYSTEM_TABLES } from '../../core/storage/system-tables.js';
import { asRlsRole } from './rls-session.js';

import { q, formulaAuth, runTableQuery, auditWrite, scriptUserOf, PARENT_COLUMNS, isDetailsChild, requireDef, bctx, META_KEY_COL, recordKeySelect, primaryNames, pkValuesOf, validateId, pkFilter, pkWhereSql, externalIdOf, needsSideTable, toolDataAccessOver, dbJsonValue } from './query-helpers.js';

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
  /** workflow timer handle: re-arm/cancel a record's `onTimeout` on state changes */
  private readonly workflowTimers?: WorkflowTimerSync;
  /** query budget (limits on rows/filters/sorts); per-context `ctx.budget` overrides */
  private readonly budget: QueryBudget;
  /** optional evidence sink (guardrail decisions on writes); absent = zero overhead */
  private readonly evidence?: EvidenceSink;
  /** schema signature (registry-derived) recorded on evidence; `ctx.schemaRevision` overrides */
  private readonly schemaRevision?: string;
  /** optional metrics sink (query-budget rejections); absent = zero overhead */
  private readonly metrics?: MetricsSink;
  /** object-path RLS role (`rls.enforce`); user-principal customer-table reads/updates/deletes run under it */
  private readonly rlsRole?: string;
  /** default `total` computation for `find` (per-call `opts.total` overrides) */
  private readonly totalMode: TotalMode;

  constructor(
    options: {
      audit?: AuditSink;
      script?: ScriptDispatcher;
      replay?: boolean;
      events?: EventPublisher;
      policies?: readonly GuardrailPolicy[];
      approvals?: PolicyApprovals;
      workflowTimers?: WorkflowTimerSync;
      budget?: QueryBudget;
      evidence?: EvidenceSink;
      schemaRevision?: string;
      metrics?: MetricsSink;
      rls?: { role: string };
      total?: TotalMode;
    } = {},
  ) {
    this.audit = options.audit;
    this.script = options.script ?? NOOP_SCRIPT_DISPATCHER;
    this.replay = options.replay ?? false;
    this.events = options.events;
    this.policies = options.policies ?? [];
    this.approvals = options.approvals;
    this.workflowTimers = options.workflowTimers;
    this.budget = options.budget ?? { ...QUERY_BUDGET_DEFAULTS };
    this.evidence = options.evidence;
    this.schemaRevision = options.schemaRevision;
    this.metrics = options.metrics;
    if (options.rls !== undefined && !isSafeRlsRole(options.rls.role)) {
      throw new Error(`invalid RLS role name "${options.rls.role}"`);
    }
    this.rlsRole = options.rls?.role;
    this.totalMode = options.total ?? TOTAL_MODES.EXACT;
  }

  /**
   * Run customer-table statements under the object RLS role for a user
   * principal (a pool request gets its own short transaction); system
   * principals and enforcement-off run as the owner.
   */
  private async readScoped<R>(ctx: DataAccessContext, fn: (db: Pool | PoolClient) => Promise<R>): Promise<R> {
    const subject = this.rlsRole === undefined ? undefined : subjectOf(ctx);
    if (subject === undefined) return fn(ctx.client ?? ctx.pool);
    const role = this.rlsRole!;
    if (ctx.client !== undefined) return asRlsRole(ctx.client, role, subject, () => fn(ctx.client!));
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await asRlsRole(client, role, subject, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** {@link readScoped} for a client already inside the write transaction */
  private underRls<R>(client: PoolClient, ctx: DataAccessContext, fn: () => Promise<R>): Promise<R> {
    const subject = this.rlsRole === undefined ? undefined : subjectOf(ctx);
    return subject === undefined ? fn() : asRlsRole(client, this.rlsRole!, subject, fn);
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
      await auditWrite(this.audit, ctx, action, objectName, objectId, changes, error);
    }
  }

  async find<T = Record<string, unknown>>(
    objectName: string,
    opts: FindOptions,
    ctx: DataAccessContext,
  ): Promise<FindResult<T>> {
    const def = requireDef(ctx, objectName);
    const pks = primaryFieldsOf(def);
    const budget = ctx.budget ?? this.budget;
    const totalMode = opts.total ?? this.totalMode;
    try {
      assertQueryBudget(opts, budget, ctx.locale);
    } catch (error) {
      if (error instanceof SchemaError) {
        this.metrics?.counter(METRIC_NAMES.QUERY_BUDGET_REJECT, 1, {
          object: objectName,
          limit: String(error.params.limit ?? ''),
        });
      }
      throw error;
    }
    const { limit } = resolvePagination(opts, budget.maxRows);
    const noneTotal = totalMode === TOTAL_MODES.NONE;

    // `total` per the effective mode: exact COUNT(*), a reltuples estimate, or
    // nothing (none). Counts run on the same (RLS-scoped) connection as the page.
    const countTotal = async (
      db: Pool | PoolClient,
      buildCtx: BuildContext,
    ): Promise<number | undefined> => {
      if (noneTotal) return undefined;
      if (totalMode === TOTAL_MODES.ESTIMATE) {
        const { sql, params } = buildEstimateSql(def);
        const { rows } = await runTableQuery(db, objectName, sql, params, ctx.locale);
        return (rows[0] as { total: number } | undefined)?.total;
      }
      const { sql, params } = buildCountSql(def, opts, buildCtx, ctx.rowScope);
      const { rows } = await runTableQuery(db, objectName, sql, params, ctx.locale);
      return (rows[0] as { total: number }).total;
    };

    // keyset cursor (single primary key): `pk > cursor` ordered by pk. A
    // caller-provided sort is ignored in cursor mode (documented) so pages
    // traverse one deterministic sequence.
    if (opts.cursor !== undefined && pks.length === 1) {
      const pkName = pks[0]!.name;
      const cursorValue = decodeCursor(opts.cursor)[0];
      const pageOpts: FindOptions = {
        ...opts,
        filter: { ...(opts.filter ?? {}), [pkName]: { [FILTER_OPS.GT]: cursorValue } },
        sort: [{ field: pkName, dir: SORT_DIRS.ASC }],
        offset: 0,
        limit: limit + 1,
      };
      const meta = needsSideTable(pageOpts) ? { table: recordMetaTableName(def.name) } : undefined;
      const buildCtx = { ...bctx(ctx, objectName), ...(meta === undefined ? {} : { meta }) };
      const { sql, params } = buildFindSql(def, pageOpts, buildCtx, ctx.rowScope, pageOpts.exclude, undefined, budget.maxRows + 1);
      const [{ rows }, total] = await this.readScoped(ctx, async (db) => [
        await runTableQuery(db, objectName, sql, params, ctx.locale),
        await countTotal(db, buildCtx),
      ]);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1] as Record<string, unknown> | undefined;
      const nextCursor = hasMore && last !== undefined ? encodeCursor([last[pkName]]) : undefined;
      const loaded = await this.runOnLoad(objectName, pageRows as Record<string, unknown>[], ctx);
      return {
        rows: loaded as T[],
        ...(total === undefined ? {} : { total }),
        hasMore,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    }

    // `weave_*` virtual fields live in the engine side table; when referenced,
    // LEFT JOIN it and select/filter/sort them in SQL (never customer columns)
    const meta = needsSideTable(opts) ? { table: recordMetaTableName(def.name) } : undefined;
    const buildCtx = { ...bctx(ctx, objectName), ...(meta === undefined ? {} : { meta }) };

    // with `total: 'none'` there is no count query to derive `hasMore`, so fetch
    // one extra row (like cursor mode) and slice it off
    const findOpts: FindOptions = noneTotal ? { ...opts, limit: limit + 1 } : opts;
    const { sql, params } = buildFindSql(def, findOpts, buildCtx, ctx.rowScope, findOpts.exclude, undefined, noneTotal ? budget.maxRows + 1 : budget.maxRows);
    const [{ rows }, total] = await this.readScoped(ctx, async (db) => [
      await runTableQuery(db, objectName, sql, params, ctx.locale),
      await countTotal(db, buildCtx),
    ]);
    const offset = opts.offset ?? 0;
    const hasMore = noneTotal ? rows.length > limit : offset + rows.length < (total ?? 0);
    const pageRows = noneTotal && hasMore ? rows.slice(0, limit) : rows;
    const loaded = await this.runOnLoad(objectName, pageRows as Record<string, unknown>[], ctx);
    return { rows: loaded as T[], ...(total === undefined ? {} : { total }), hasMore };
  }

  async findOne<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    ctx: DataAccessContext,
  ): Promise<T | null> {
    const def = requireDef(ctx, objectName);
    if (primaryNames(def).length === 0) {
      throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
    }
    // project every declared column plus the derived `weave_id` (the record's
    // external id) so a fetched record is self-identifying
    const cols = def.fields.filter((f) => f.type !== FIELD_TYPES.DETAILS).map((f) => f.name);
    if (isDetailsChild(ctx.registry, objectName)) cols.push(...PARENT_COLUMNS);
    const result = await this.find<T>(
      objectName,
      { filter: pkFilter(def, pkValuesOf(def, id, ctx)), limit: 1, fields: [...cols, RECORD_META_ID_FIELD] },
      ctx,
    );
    return result.rows[0] ?? null;
  }

  /** pipeline context (actor/subject/correlation) for a governed write */
  private pipelineCtx(ctx: DataAccessContext): PipelineContext {
    const subject = subjectOf(ctx);
    const actorId = principalActorId(ctx.principal);
    const schemaRevision = ctx.schemaRevision ?? this.schemaRevision;
    return {
      actor: { key: actorId, label: subject?.id ?? 'system', onBehalfOf: subject?.id ?? actorId },
      subject: subject ?? { id: 'system', roles: [] },
      ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
      ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
      ...(schemaRevision === undefined ? {} : { schemaRevision }),
      ...(ctx.locale === undefined ? {} : { locale: ctx.locale }),
    };
  }

  /** guardrail + approval decision for `action` (shared by writes and transitions) */
  private async decide(
    action: string,
    args: Record<string, unknown>,
    ctx: DataAccessContext,
    pctx: PipelineContext,
    requireApproval: boolean,
  ): Promise<PipelineGate> {
    const guardrailCtx: GuardrailContext = {
      actor: pctx.actor,
      subject: pctx.subject,
      action,
      args,
      dataAccess: toolDataAccessOver(this, {
        pool: ctx.pool,
        registry: ctx.registry,
        principal: ctx.principal,
        ...(ctx.locale === undefined ? {} : { locale: ctx.locale }),
        ...(ctx.client === undefined ? {} : { client: ctx.client }),
      }),
    };
    const gate = await evaluateTransition(this.policies, this.approvals, guardrailCtx, requireApproval);
    if (gate.kind === 'deny') return { kind: 'deny', reason: gate.reason ?? '', errorCode: gate.code };
    return gate;
  }

  /**
   * Run a write (create/update/delete/transition) through the execution
   * pipeline: guardrail/approval gate (when policies or `requireApproval` apply)
   * → execute → one evidence row (when evidence is enabled). Protocol-agnostic
   * (action `object.<object>.<op>` / `workflow.transition.<object>.<action>`),
   * so REST / MCP / GraphQL / script writes share this single choke point.
   * Without policies, approval or evidence the write runs directly.
   */
  private async governed<T>(
    plan: ExecutionPlan,
    ctx: DataAccessContext,
    opts: {
      pendingCode: MessageKey;
      /** `action` message param (defaults to the plan action) */
      actionParam?: string;
      requireApproval?: () => Promise<boolean>;
      preflight?: () => Promise<void>;
      /** called with a preflight/deny/pending error before it is thrown */
      onReject?: (error: unknown) => Promise<void>;
    },
    execute: () => Promise<T>,
  ): Promise<T> {
    const gated = this.policies.length > 0 || opts.requireApproval !== undefined;
    if (!gated && this.evidence === undefined) return execute();
    const reject = async (error: unknown): Promise<never> => {
      await opts.onReject?.(error);
      throw error;
    };
    if (opts.preflight !== undefined) await opts.preflight().catch(reject);
    const pctx = this.pipelineCtx(ctx);
    const result = await runPipeline(plan, pctx, {
      ...(gated
        ? {
            gate: async () =>
              this.decide(plan.action, plan.args, ctx, pctx, (await opts.requireApproval?.()) ?? false),
          }
        : {}),
      execute,
      ...(this.evidence === undefined ? {} : { evidence: this.evidence }),
    });
    const params = { object: plan.objectName ?? '', action: opts.actionParam ?? plan.action };
    if (result.outcome === EXECUTION_OUTCOMES.OK) return result.result as T;
    if (result.outcome === EXECUTION_OUTCOMES.PENDING) {
      return reject(new SchemaError(opts.pendingCode, { ...params, approvalKey: result.approvalKey ?? '' }, ctx.locale));
    }
    if (result.outcome === EXECUTION_OUTCOMES.DENY) {
      return reject(
        new SchemaError((result.errorCode ?? 'mcp.policy.denied') as MessageKey, { ...params, reason: result.reason ?? '' }, ctx.locale),
      );
    }
    throw result.error;
  }

  async create<T = Record<string, unknown>>(
    objectName: string,
    data: Record<string, unknown>,
    ctx: DataAccessContext,
  ): Promise<T> {
    requireDef(ctx, objectName);
    return this.governed(
      { action: `object.${objectName}.create`, objectName, args: data },
      ctx,
      { pendingCode: 'object.action.pending' },
      () => this.doCreate<T>(objectName, data, ctx),
    );
  }

  async update<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    changes: Record<string, unknown>,
    ctx: DataAccessContext,
  ): Promise<T> {
    validateId(requireDef(ctx, objectName), id, ctx);
    return this.governed(
      { action: `object.${objectName}.update`, objectName, objectId: id, args: changes },
      ctx,
      { pendingCode: 'object.action.pending' },
      () => this.doUpdate<T>(objectName, id, changes, ctx),
    );
  }

  async delete(objectName: string, id: string, ctx: DataAccessContext): Promise<void> {
    validateId(requireDef(ctx, objectName), id, ctx);
    return this.governed(
      { action: `object.${objectName}.delete`, objectName, objectId: id, args: {} },
      ctx,
      { pendingCode: 'object.action.pending' },
      () => this.doDelete(objectName, id, ctx),
    );
  }

  private async doCreate<T = Record<string, unknown>>(
    objectName: string,
    data: Record<string, unknown>,
    ctx: DataAccessContext,
  ): Promise<T> {
    const def = requireDef(ctx, objectName);
    if (primaryNames(def).length === 0) {
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
          (field.type === FIELD_TYPES.DATE ||
            field.type === FIELD_TYPES.TIMESTAMP ||
            field.type === FIELD_TYPES.TIMESTAMPTZ) &&
          raw.default === 'now'
            ? now.toISOString()
            : raw.default;
      }
      Object.assign(record, payload);

      // row-scope: force the scope column to the subject's scope — a scoped
      // subject must not create rows attributed to another scope
      const scopeField = scopeFieldName(def);
      const scopeValue = scopeOf(ctx);
      if (scopeField !== undefined && scopeValue !== undefined) record[scopeField] = scopeValue;

      const seqFields = def.fields.filter((f) => f.type === FIELD_TYPES.SEQ_NO);
      if (seqFields.length > 0) {
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
        ...def.fields
          .filter((f) => f.type !== FIELD_TYPES.DETAILS && f.type !== FIELD_TYPES.MULTI_RELATION)
          .map((f) => f.name),
        ...(child ? [...PARENT_COLUMNS] : []),
      ];
      const fieldByName = new Map(def.fields.map((f) => [f.name, f]));
      const values = cols.map((c) => dbJsonValue(fieldByName.get(c), record[c] ?? null));
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const insertRes = await runTableQuery(
        client,
        def.name,
        `INSERT INTO ${q(def.name)} (${cols.map(q).join(', ')}) VALUES (${placeholders}) RETURNING ${recordKeySql(def, q)} AS ${q(META_KEY_COL)}`,
        values,
        ctx.locale,
      );
      const metaKey = String((insertRes.rows[0] as Record<string, unknown> | undefined)?.[META_KEY_COL] ?? '');
      const externalId = metaKey;
      record[RECORD_META_ID_FIELD] = externalId;

      await insertDetails(client, def, externalId, payload, ctx.registry, ctx.locale);
      await insertLinks(
        client,
        def,
        primaryFieldsOf(def).map((f) => record[f.name]),
        payload,
        ctx.registry,
        ctx.locale,
      );

      // compute formula fields AFTER children exist (aggregates see them), then persist
      await computeFormulas(def, record, client, ctx.registry, now, externalId, formulaAuth(ctx));
      const formulaCols = def.fields
        .filter((f) => (f as { formula?: string }).formula !== undefined)
        .map((f) => f.name);
      if (formulaCols.length > 0) {
        const setSql = formulaCols.map((c, i) => `${q(c)} = $${i + 1}`).join(', ');
        const formulaValues = formulaCols.map((c) => record[c] ?? null);
        const pkValues = pkValuesOf(def, externalId, ctx);
        await runTableQuery(
          client,
          def.name,
          `UPDATE ${q(def.name)} SET ${setSql} WHERE ${pkWhereSql(def, formulaCols.length + 1)}`,
          [...formulaValues, ...pkValues],
          ctx.locale,
        );
      }

      await this.writeRecordMeta(client, def, metaKey, ctx, now, true);
      const auditInTx = this.audit?.recordInTx !== undefined;
      if (auditInTx) {
        await auditWrite(this.audit, ctx, DATA_ACTIONS.CREATE, objectName, externalId, record, undefined, undefined, undefined, client);
      }
      if (owned) await client.query('COMMIT');
      if (!auditInTx) {
        await auditWrite(this.audit, ctx, DATA_ACTIONS.CREATE, objectName, externalId, record);
      }
      this.events?.publishRecordChange('created', objectName, externalId);
      await this.runAfterHook(SCRIPT_HOOKS.AFTER_UPDATE, DATA_ACTIONS.CREATE, objectName, record, payload, ctx, warnings, externalId);
      if (warnings.length > 0) ctx.onWarnings?.(warnings);
      const loaded = await this.runOnLoad(objectName, [record], ctx);
      return loaded[0] as T;
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      const failedId = primaryNames(def).every((n) => data[n] !== undefined)
        ? externalIdOf(def, data)
        : undefined;
      await auditWrite(this.audit, ctx, DATA_ACTIONS.CREATE, objectName, failedId, data, err);
      throw err;
    } finally {
      if (owned) client.release();
    }
  }

  private async doUpdate<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    changes: Record<string, unknown>,
    ctx: DataAccessContext,
  ): Promise<T> {
    const def = requireDef(ctx, objectName);
    if (primaryNames(def).length === 0) {
      throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
    }
    const pkValues = pkValuesOf(def, id, ctx);
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

      const { sql, params } = buildFindSql(def, { filter: pkFilter(def, pkValues), limit: 1 }, bctx(ctx, objectName), ctx.rowScope, undefined, [recordKeySelect(def)]);
      const { rows } = await this.underRls(client, ctx, () => runTableQuery(client, objectName, sql, params, ctx.locale));
      const raw = rows[0] as Record<string, unknown> | undefined;
      if (raw === undefined) {
        throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      }
      const metaKey = String(raw[META_KEY_COL] ?? '');
      const existing = { ...raw };
      delete existing[META_KEY_COL];

      // validate → beforeUpdate; hooks see the pre-update record and may rewrite changes
      await this.runBeforeHook(SCRIPT_HOOKS.VALIDATE, objectName, existing, changes, ctx);
      let payload = changes;
      const before = await this.runBeforeHook(SCRIPT_HOOKS.BEFORE_UPDATE, objectName, existing, changes, ctx);
      if (before !== undefined) payload = before;

      // primary keys are immutable: reject any attempt to change them (drift-free record_key)
      for (const name of primaryNames(def)) {
        if (payload[name] !== undefined) {
          throw new SchemaError('object.primary.mutable', { object: objectName, field: name }, ctx.locale);
        }
      }

      // row-scope: the scope column is immutable — a scoped subject must not move
      // a row into another scope (error code kept as `object.scope.immutable` for compat)
      const scopeField = scopeFieldName(def);
      const scopeValue = scopeOf(ctx);
      if (
        scopeField !== undefined &&
        scopeValue !== undefined &&
        payload[scopeField] !== undefined &&
        payload[scopeField] !== scopeValue
      ) {
        throw new SchemaError('object.scope.immutable', { object: objectName, field: scopeField }, ctx.locale);
      }

      const now = new Date();
      const record = { ...existing, ...payload };
      record[RECORD_META_ID_FIELD] = metaKey;
      await computeFormulas(def, record, client, ctx.registry, now, metaKey, formulaAuth(ctx));

      const settable = new Set<string>();
      for (const key of Object.keys(payload)) {
        if (isDetailsChild(ctx.registry, def.name) && PARENT_COLUMNS.has(key)) {
          settable.add(key);
          continue;
        }
        const field = def.fields.find((f) => f.name === key);
        if (field !== undefined && field.type !== FIELD_TYPES.DETAILS && field.type !== FIELD_TYPES.MULTI_RELATION) {
          settable.add(key);
        }
      }
      for (const field of def.fields) {
        if ((field as { formula?: string }).formula !== undefined) settable.add(field.name);
      }
      for (const name of primaryNames(def)) settable.delete(name);

      if (settable.size > 0) {
        const cols = [...settable];
        const setSql = cols.map((c, i) => `${q(c)} = $${i + 1}`).join(', ');
        const scope = ctx.rowScope !== undefined ? scopeSuffix(ctx.rowScope, cols.length + pkValues.length) : undefined;
        const values = cols.map((c) => dbJsonValue(def.fields.find((f) => f.name === c), record[c] ?? null));
        const res = await this.underRls(client, ctx, () =>
          runTableQuery(
            client,
            objectName,
            `UPDATE ${q(def.name)} SET ${setSql} WHERE ${pkWhereSql(def, cols.length + 1)}${scope !== undefined ? ` AND (${scope.sql})` : ''}`,
            [...values, ...pkValues, ...(scope?.params ?? [])],
            ctx.locale,
          ),
        );
        if (res.rowCount === 0) throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      }

      await this.writeRecordMeta(client, def, metaKey, ctx, now, false);
      await replaceLinks(client, def, pkValues, payload, ctx.registry, ctx.locale);
      const auditInTx = this.audit?.recordInTx !== undefined;
      if (auditInTx) {
        await auditWrite(this.audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, payload, undefined, this.replay ? existing : undefined, this.replay ? record : undefined, client);
      }
      if (owned) await client.query('COMMIT');
      if (!auditInTx) {
        await auditWrite(this.audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, payload, undefined, this.replay ? existing : undefined, this.replay ? record : undefined);
      }
      this.events?.publishRecordChange('updated', objectName, id);
      await this.runAfterHook(SCRIPT_HOOKS.AFTER_UPDATE, DATA_ACTIONS.UPDATE, objectName, record, payload, ctx, warnings, id);
      if (warnings.length > 0) ctx.onWarnings?.(warnings);
      const loaded = await this.runOnLoad(objectName, [record], ctx);
      return loaded[0] as T;
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      await auditWrite(this.audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, changes, err);
      throw err;
    } finally {
      if (owned) client.release();
    }
  }

  /**
   * Fire a workflow action against the three-layer runtime (instance/step/
   * workitem). Runs in one transaction: the instance row is locked, the current
   * step's workitems are quorum-evaluated, the new step/workitems are opened and
   * the side-table status mirror is updated. The customer row is never touched.
   */
  async transition<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    action: string,
    ctx: DataAccessContext,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const def = requireDef(ctx, objectName);
    const workflow = def.workflow;
    if (workflow === undefined) {
      throw new SchemaError('workflow.transition.unknown', { object: objectName, action }, ctx.locale);
    }
    if (primaryNames(def).length === 0) {
      throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
    }
    const pkValues = pkValuesOf(def, id, ctx);
    // a policy self-filters on `workflow.transition.<object>.<action>`; a node may
    // also declare `requiresApproval` (deny → error; requireApproval → pending)
    const approvalNodes = workflow.nodes.some((n) => n.requiresApproval === true);
    return this.governed(
      { action: `workflow.transition.${def.name}.${action}`, objectName, objectId: id, args: { object: def.name, id, action } },
      ctx,
      {
        pendingCode: 'workflow.transition.pending',
        actionParam: action,
        preflight: async () => {
          const [sql, params] = this.transitionTargetSql(def, pkValues, action, ctx);
          const { rows } =
            action === WORKFLOW_ACTIONS.SUBMIT
              ? await this.readScoped(ctx, (db) => runTableQuery(db, objectName, sql, params, ctx.locale))
              : await runTableQuery(ctx.client ?? ctx.pool, objectName, sql, params, ctx.locale);
          if (rows[0] === undefined) throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
        },
        onReject: (error) => auditWrite(this.audit, ctx, DATA_ACTIONS.TRANSITION, objectName, id, { action }, error),
        ...(approvalNodes
          ? {
              requireApproval: async () => {
                const status = await getWorkflowStatus(ctx.client ?? ctx.pool, def, id, subjectOf(ctx));
                return workflow.nodes.find((n) => n.id === status.node)?.requiresApproval === true;
              },
            }
          : {}),
      },
      () => this.doTransition<T>(def, id, pkValues, action, ctx, payload),
    );
  }

  /**
   * Existence check for a transition target. Submit is an owner action → the
   * caller's manage scope; the other actions are authorized by workitem
   * assignment / originator, not by row scope.
   */
  private transitionTargetSql(
    def: ObjectDefinition,
    pkValues: readonly string[],
    action: string,
    ctx: DataAccessContext,
  ): [string, unknown[]] {
    const { sql, params } = buildFindSql(
      def,
      { filter: pkFilter(def, pkValues), limit: 1 },
      bctx(ctx, def.name),
      action === WORKFLOW_ACTIONS.SUBMIT ? ctx.rowScope : undefined,
      undefined,
      [recordKeySelect(def)],
    );
    return [sql, params];
  }

  private async doTransition<T>(
    def: ObjectDefinition,
    id: string,
    pkValues: readonly string[],
    action: string,
    ctx: DataAccessContext,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const objectName = def.name;
    const workflow = def.workflow!;
    let client: PoolClient;
    let owned = false;
    if (ctx.client !== undefined) {
      client = ctx.client;
    } else {
      owned = true;
      client = await ctx.pool.connect();
    }
    try {
      if (owned) await client.query('BEGIN');
      // the customer record must exist (transitions never create records)
      const [sql, params] = this.transitionTargetSql(def, pkValues, action, ctx);
      const lookup = () => runTableQuery(client, objectName, sql, params, ctx.locale);
      const found = action === WORKFLOW_ACTIONS.SUBMIT ? await this.underRls(client, ctx, lookup) : await lookup();
      if (found.rows[0] === undefined) {
        throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      }

      const outcome = await runWorkflowTransition(client, def, id, action, subjectOf(ctx), payload, ctx.locale);
      const transitionChanges = {
        action,
        node: outcome.toNodeId ?? null,
        from: outcome.fromNodeId ?? null,
        ...(def.workflowHash === undefined ? {} : { workflowHash: def.workflowHash }),
      };
      const auditInTx = this.audit?.recordInTx !== undefined;
      if (auditInTx) {
        await auditWrite(this.audit, ctx, DATA_ACTIONS.TRANSITION, objectName, id, transitionChanges, undefined, undefined, undefined, client);
      }
      if (owned) await client.query('COMMIT');
      if (!auditInTx) {
        await auditWrite(this.audit, ctx, DATA_ACTIONS.TRANSITION, objectName, id, transitionChanges);
      }
      this.events?.publishRecordChange('updated', objectName, id);
      this.events?.publishRecordTransitioned(
        objectName,
        id,
        outcome.fromNodeId ?? '',
        outcome.toNodeId ?? '',
        action,
        workflow.version,
        def.workflowHash,
      );
      if (outcome.nodeId !== undefined) {
        await this.workflowTimers?.sync(objectName, id, outcome.nodeId).catch(() => {});
      } else {
        await this.workflowTimers?.cancel(objectName, id).catch(() => {});
      }
      const updated = await this.findOne<Record<string, unknown>>(objectName, id, ctx);
      const transitionInfo = { from: outcome.fromNodeId ?? '', to: outcome.toNodeId ?? '' };
      const warnings: string[] = [];
      if (updated !== null) {
        await this.runAfterHook(SCRIPT_HOOKS.ON_EXIT, DATA_ACTIONS.TRANSITION, objectName, updated, {}, ctx, warnings, id, { transition: transitionInfo, state: outcome.fromNodeId });
        await this.runAfterHook(SCRIPT_HOOKS.ON_ENTER, DATA_ACTIONS.TRANSITION, objectName, updated, {}, ctx, warnings, id, { transition: transitionInfo, state: outcome.toNodeId });
        await this.runAfterHook(SCRIPT_HOOKS.AFTER_TRANSITION, DATA_ACTIONS.TRANSITION, objectName, updated, {}, ctx, warnings, id, { transition: transitionInfo, state: outcome.toNodeId });
      }
      if (warnings.length > 0) ctx.onWarnings?.(warnings);
      return updated as T;
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      await auditWrite(this.audit, ctx, DATA_ACTIONS.TRANSITION, objectName, id, { action }, err);
      throw err;
    } finally {
      if (owned) client.release();
    }
  }


  /**
   * Read a record's workflow status (state/node/actions/own workitems).
   */
  async workflowStatus(objectName: string, id: string, ctx: DataAccessContext): Promise<WorkflowStatus> {
    const def = requireDef(ctx, objectName);
    if (def.workflow === undefined) {
      throw new SchemaError('workflow.transition.unknown', { object: objectName, action: 'status' }, ctx.locale);
    }
    await this.assertWorkflowVisible(def, id, ctx);
    return getWorkflowStatus(ctx.client ?? ctx.pool, def, id, subjectOf(ctx));
  }

  /**
   * A record's workflow is visible when the record is inside the caller's read
   * scope, or the caller participates (originator / any workitem) — an assigned
   * approver may sit outside the record's row scope.
   */
  private async assertWorkflowVisible(def: ObjectDefinition, id: string, ctx: DataAccessContext): Promise<void> {
    if (ctx.rowScope === undefined) return;
    const db = ctx.client ?? ctx.pool;
    const pkValues = pkValuesOf(def, id, ctx);
    const { sql, params } = buildFindSql(def, { filter: pkFilter(def, pkValues), limit: 1 }, bctx(ctx, def.name), ctx.rowScope);
    const { rows } = await this.readScoped(ctx, (scoped) => runTableQuery(scoped, def.name, sql, params, ctx.locale));
    if (rows.length > 0) return;
    const subject = subjectOf(ctx);
    if (subject !== undefined) {
      const res = await db.query(
        `SELECT 1 FROM ${q(SYSTEM_TABLES.WORKFLOW_INSTANCES)} WHERE object = $1 AND record_key = $2 AND originator = $3
         UNION ALL
         SELECT 1 FROM ${q(SYSTEM_TABLES.WORKFLOW_WORKITEMS)} WHERE object = $1 AND record_key = $2 AND participant = $3
         LIMIT 1`,
        [def.name, id, subject.id],
      );
      if (res.rows.length > 0) return;
    }
    throw new SchemaError('data.recordNotFound', { object: def.name, id }, ctx.locale);
  }

  /** Acquire/renew the caller's presence lock on the current step (TTL lease). */
  async acquireWorkflowLock(objectName: string, id: string, ctx: DataAccessContext): Promise<{ expiresAt: Date }> {
    const def = requireDef(ctx, objectName);
    return acquireWorkflowLock(ctx.pool, def, id, subjectOf(ctx), ctx.locale);
  }

  /** Release the caller's presence lock. */
  async releaseWorkflowLock(objectName: string, id: string, ctx: DataAccessContext): Promise<void> {
    const def = requireDef(ctx, objectName);
    await releaseWorkflowLock(ctx.pool, def, id, subjectOf(ctx));
  }

  /** Read a record's workflow history (steps + workitems). */
  async workflowHistory(objectName: string, id: string, ctx: DataAccessContext): Promise<WorkflowHistory> {
    const def = requireDef(ctx, objectName);
    if (def.workflow === undefined) {
      throw new SchemaError('workflow.transition.unknown', { object: objectName, action: 'history' }, ctx.locale);
    }
    await this.assertWorkflowVisible(def, id, ctx);
    return getWorkflowHistory(ctx.client ?? ctx.pool, def, id);
  }

  /** The subject's pending workitems across all objects. */
  async workflowTodos(ctx: DataAccessContext): Promise<WorkflowTodo[]> {
    return getWorkflowTodos(ctx.pool, subjectOf(ctx));
  }

  /** Admin override: jump the record to a node or terminate the instance. */
  async overrideWorkflow(
    objectName: string,
    id: string,
    patch: WorkflowOverride,
    ctx: DataAccessContext,
  ): Promise<{ state: string; nodeId?: string }> {
    const def = requireDef(ctx, objectName);
    if (def.workflow === undefined) {
      throw new SchemaError('workflow.transition.unknown', { object: objectName, action: 'override' }, ctx.locale);
    }
    let client: PoolClient;
    let owned = false;
    if (ctx.client !== undefined) {
      client = ctx.client;
    } else {
      owned = true;
      client = await ctx.pool.connect();
    }
    try {
      if (owned) await client.query('BEGIN');
      const result = await overrideWorkflow(client, def, id, patch, subjectOf(ctx), ctx.locale);
      if (owned) await client.query('COMMIT');
      if (result.nodeId !== undefined) {
        await this.workflowTimers?.sync(objectName, id, result.nodeId).catch(() => {});
      } else {
        await this.workflowTimers?.cancel(objectName, id).catch(() => {});
      }
      return result;
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (owned) client.release();
    }
  }

  /**
   * Upsert a record's sparse metadata side-table row (status/owner/timestamps)
   * inside the caller's transaction. `created` also stamps the creation facts.
   */
  private async writeRecordMeta(
    client: PoolClient,
    def: ObjectDefinition,
    key: string,
    ctx: DataAccessContext,
    now: Date,
    created: boolean,
  ): Promise<void> {
    const actor = subjectOf(ctx)?.id ?? principalActorId(ctx.principal);
    await upsertRecordMeta(
      client,
      def.name,
      key,
      created
        ? { createdBy: actor, modifiedBy: actor, createdTime: now, modifiedTime: now }
        : { modifiedBy: actor, modifiedTime: now },
    );
  }

  private async doDelete(objectName: string, id: string, ctx: DataAccessContext): Promise<void> {
    const def = requireDef(ctx, objectName);
    if (primaryNames(def).length === 0) {
      throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
    }
    const pkValues = pkValuesOf(def, id, ctx);
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
      const { sql, params } = buildFindSql(def, { filter: pkFilter(def, pkValues), limit: 1 }, bctx(ctx, objectName), ctx.rowScope, undefined, [recordKeySelect(def)]);
      const { rows } = await this.underRls(client, ctx, () => runTableQuery(client, objectName, sql, params, ctx.locale));
      const raw = rows[0] as Record<string, unknown> | undefined;
      if (raw === undefined) {
        throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      }
      const metaKey = String(raw[META_KEY_COL] ?? '');
      const existing = { ...raw };
      delete existing[META_KEY_COL];

      await this.runBeforeHook(SCRIPT_HOOKS.BEFORE_DELETE, objectName, existing, {}, ctx);
      await deleteDetailsChildren(client, def, id, ctx.registry);
      const scope = ctx.rowScope !== undefined ? scopeSuffix(ctx.rowScope, pkValues.length) : undefined;
      const res = await this.underRls(client, ctx, () =>
        runTableQuery(
          client,
          objectName,
          `DELETE FROM ${q(def.name)} WHERE ${pkWhereSql(def, 1)}${scope !== undefined ? ` AND (${scope.sql})` : ''}`,
          [...pkValues, ...(scope?.params ?? [])],
          ctx.locale,
        ),
      );
      if (res.rowCount === 0) throw new SchemaError('data.recordNotFound', { object: objectName, id }, ctx.locale);
      await deleteRecordMeta(client, def.name, metaKey);
      const auditInTx = this.audit?.recordInTx !== undefined;
      if (auditInTx) {
        await auditWrite(this.audit, ctx, DATA_ACTIONS.DELETE, objectName, id, undefined, undefined, this.replay ? existing : undefined, undefined, client);
      }
      if (owned) await client.query('COMMIT');
      if (!auditInTx) {
        await auditWrite(this.audit, ctx, DATA_ACTIONS.DELETE, objectName, id, undefined, undefined, this.replay ? existing : undefined);
      }
      this.events?.publishRecordChange('deleted', objectName, id);
      await this.workflowTimers?.cancel(objectName, id).catch(() => {});
      await this.runAfterHook(SCRIPT_HOOKS.AFTER_DELETE, DATA_ACTIONS.DELETE, objectName, existing, {}, ctx, warnings, id);
      if (warnings.length > 0) ctx.onWarnings?.(warnings);
    } catch (err) {
      if (owned) await client.query('ROLLBACK');
      await auditWrite(this.audit, ctx, DATA_ACTIONS.DELETE, objectName, id, undefined, err);
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
    workflowTimers?: WorkflowTimerSync;
    budget?: QueryBudget;
    evidence?: EvidenceSink;
    schemaRevision?: string;
    metrics?: MetricsSink;
    rls?: { role: string };
    total?: TotalMode;
  } = {},
): ObjectDataAccess {
  return new DefaultObjectDataAccess(options);
}
