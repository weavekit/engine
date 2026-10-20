import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { APPROVAL_EVENT_TYPES, NOOP_AUDIT_SINK, createMemoryApprovalsBackend, userPrincipal, SchemaError, validateToolArgs, DEFAULT_LOCALE } from '../../core/index.js';
import { AUDIT_ACTOR_TYPES } from '../../core/index.js';
import type { ApprovalEvent, ApprovalEventSink, ApprovalEventType, ApprovalVote, ApprovalDelegationResolver, AuditSink, IdentitySubject, Locale, ObjectRegistry, ToolActor, ToolApprovals, ApprovalsBackend, ApprovalListFilter, ToolCallContext, ToolDataAccess, ToolDefinition, ToolGuardrails, ToolJsonSchema, ToolResult, ApprovalStatus, PendingApproval, ApprovalRequestContext, GuardrailContext, GuardrailPolicy, EvidenceSink } from '../../core/index.js';
import type { ObjectDataAccess, DataAccessContext, FindOptions } from '../data-access/index.js';
import { withTx as dataAccessWithTx } from '../data-access/index.js';
import { applyMask, evaluateCall } from './policies.js';
import { runPipeline } from '../execution/pipeline.js';

/**
 * Custom-tool execution pipeline (protocol-agnostic). Wraps the injected
 * (RBAC-decorated) data-access with the controlled `ToolDataAccess` surface,
 * builds the `ToolCallContext` a handler receives, runs the handler with
 * auto-audit and wires `withTx`. `adapters/mcp` binds protocol specifics
 * (`McpSession → ToolActor`, `mcp.tool.<name>` action) on top of this.
 *
 * The guardrail policy pipeline (`evaluatePolicies`) runs in front of
 * `execute`; approvals already live here as the queue the executor exposes.
 */

/** deterministic approval key for a pending decision (repeat calls don't duplicate) */
export function approvalKeyFor(
  actor: ToolActor,
  action: string,
  args: Record<string, unknown>,
  requestId?: string,
): string {
  const raw = JSON.stringify(requestId === undefined ? [actor.key, action, args] : [actor.key, action, args, requestId]);
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  return `ap-${Math.abs(hash).toString(36)}`;
}

function requestHashFor(
  actor: ToolActor,
  action: string,
  args: Record<string, unknown>,
  requestId?: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify(requestId === undefined ? [actor.key, action, args] : [actor.key, action, args, requestId]))
    .digest('hex');
}

/** full approval queue handle (query/approve/reject + enqueue for the policy gate; async - persisted backend) */
export type ApprovalsQueue = ToolApprovals & {
  pending(
    action: string,
    args: Record<string, unknown>,
    actor: ToolActor,
    key?: string,
    context?: ApprovalRequestContext,
  ): Promise<void>;
  consume(approvalKey: string, by: string): Promise<boolean>;
};

const DEFAULT_APPROVAL_TTL_MS = 72 * 3_600_000;

/**
 * Approval queue (release-grade): thin facade over a pluggable
 * `ApprovalsBackend` (in-memory default; PG in `subsystems/approvals`). No Redis
 * backend is implemented. `approvalKey` stays deterministic; resolution
 * is audited here, never by the store. Async because the backend performs I/O.
 */
export function createApprovals(
  options: {
    audit?: AuditSink;
    backend?: ApprovalsBackend;
    ttlMs?: number;
    events?: ApprovalEventSink;
    delegation?: ApprovalDelegationResolver;
  } = {},
): ApprovalsQueue {
  const backend = options.backend ?? createMemoryApprovalsBackend();
  const audit = options.audit ?? NOOP_AUDIT_SINK;
  const ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const events = options.events;
  const delegation = options.delegation;

  const auditApproval = (
    action: string,
    actorType: (typeof AUDIT_ACTOR_TYPES)[keyof typeof AUDIT_ACTOR_TYPES],
    actorId: string,
    entry: PendingApproval | undefined,
    meta: Record<string, unknown>,
  ): void => {
    void audit
      .record({
        actorType,
        actorId,
        action,
        ...(entry === undefined ? {} : { changes: { action: entry.action, args: entry.args } }),
        isError: false,
        meta: {
          ...(entry === undefined ? {} : { approvalKey: entry.approvalKey, requestHash: entry.requestHash }),
          ...meta,
        },
        timestamp: new Date(),
      })
      .catch(() => {});
  };

  const emitApproval = (
    type: ApprovalEventType,
    entry: PendingApproval | undefined,
    extra: Partial<ApprovalEvent> = {},
  ): void => {
    if (events === undefined || entry === undefined) return;
    const event: ApprovalEvent = {
      type,
      approvalKey: entry.approvalKey,
      action: entry.action,
      actorKey: entry.actorKey,
      ...(entry.requestedBy === undefined ? {} : { requestedBy: entry.requestedBy }),
      ...(entry.onBehalfOf === undefined ? {} : { onBehalfOf: entry.onBehalfOf }),
      ...(entry.actorLabel === undefined ? {} : { actorLabel: entry.actorLabel }),
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.policy === undefined ? {} : { policy: entry.policy }),
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      ...(entry.consumedAt === undefined ? {} : { consumedAt: entry.consumedAt }),
      ...(entry.resolvedAt === undefined ? {} : { resolvedAt: entry.resolvedAt }),
      ...(entry.comment === undefined ? {} : { comment: entry.comment }),
      occurredAt: new Date(),
      ...extra,
    };
    void Promise.resolve(events.emit(event)).catch(() => {});
  };

  const resolve = async (
    approvalKey: string,
    by: string,
    status: 'approved' | 'rejected',
    comment?: string,
  ): Promise<boolean> => {
    const current = await backend.get(approvalKey);
    if (current === undefined) return false;
    if (current.requestedBy !== undefined && current.requestedBy === by) {
      auditApproval('approval.denied', AUDIT_ACTOR_TYPES.USER, by, current, {
        reason: 'segregation-of-duties',
        approver: by,
      });
      emitApproval(APPROVAL_EVENT_TYPES.DENIED, current, {
        approver: by,
        reason: 'segregation-of-duties',
      });
      return false;
    }
    if (current.expiresAt !== undefined && current.expiresAt.getTime() <= Date.now()) {
      auditApproval('approval.expired', AUDIT_ACTOR_TYPES.SYSTEM, 'system', current, {
        expiresAt: current.expiresAt.toISOString(),
      });
      emitApproval(APPROVAL_EVENT_TYPES.EXPIRED, current, { reason: 'expired' });
      return false;
    }
    if (backend.vote !== undefined) {
      const delegatedBy =
        delegation === undefined ? undefined : await delegation.resolve(by, current.action);
      const delegated = delegatedBy === undefined ? {} : { delegatedBy };
      const ok = await backend.vote(approvalKey, {
        approvalKey,
        approver: by,
        decision: status,
        ...(comment === undefined ? {} : { comment }),
        ...delegated,
        stage: 0,
        createdAt: new Date(),
      });
      if (!ok) return false;
      const entry = await backend.get(approvalKey);
      if (entry?.status === 'approved') {
        auditApproval('approval.approved', AUDIT_ACTOR_TYPES.USER, by, entry, {
          approver: by,
          status,
          ...(comment === undefined ? {} : { comment }),
          approvedCount: entry.approvedCount,
        });
        emitApproval(APPROVAL_EVENT_TYPES.APPROVED, entry, {
          approver: by,
          ...(comment === undefined ? {} : { comment }),
        });
      } else if (entry?.status === 'rejected') {
        auditApproval('approval.rejected', AUDIT_ACTOR_TYPES.USER, by, entry, {
          approver: by,
          status,
          ...(comment === undefined ? {} : { comment }),
        });
        emitApproval(APPROVAL_EVENT_TYPES.REJECTED, entry, {
          approver: by,
          ...(comment === undefined ? {} : { comment }),
        });
      } else {
        auditApproval('approval.vote', AUDIT_ACTOR_TYPES.USER, by, entry, {
          approver: by,
          decision: status,
          approvedCount: entry?.approvedCount,
          requiredApprovals: entry?.requiredApprovals,
          ...(comment === undefined ? {} : { comment }),
        });
        emitApproval(APPROVAL_EVENT_TYPES.VOTE, entry, {
          approver: by,
          ...(comment === undefined ? {} : { comment }),
        });
      }
      return true;
    }

    const ok = await backend.resolve(approvalKey, by, status, comment);
    if (ok) {
      const entry = await backend.get(approvalKey);
      auditApproval(
        status === 'approved' ? 'approval.approved' : 'approval.rejected',
        AUDIT_ACTOR_TYPES.USER,
        by,
        entry,
        { approver: by, status, ...(comment === undefined ? {} : { comment }) },
      );
      emitApproval(
        status === 'approved' ? APPROVAL_EVENT_TYPES.APPROVED : APPROVAL_EVENT_TYPES.REJECTED,
        entry,
        { approver: by, ...(comment === undefined ? {} : { comment }) },
      );
    }
    return ok;
  };

  return {
    list(filter?: ApprovalListFilter): Promise<PendingApproval[]> {
      return backend.list(filter);
    },
    count(filter?: ApprovalListFilter): Promise<number> {
      return backend.count(filter);
    },
    async query(status?: ApprovalStatus): Promise<PendingApproval[]> {
      return backend.list(status === undefined ? {} : { status });
    },
    approve(approvalKey: string, by: string, comment?: string): Promise<boolean> {
      return resolve(approvalKey, by, 'approved', comment);
    },
    reject(approvalKey: string, by: string, comment?: string): Promise<boolean> {
      return resolve(approvalKey, by, 'rejected', comment);
    },
    vote(approvalKey: string, vote: ApprovalVote): Promise<boolean> {
      return resolve(approvalKey, vote.approver, vote.decision, vote.comment);
    },
    votes(approvalKey: string): Promise<ApprovalVote[]> {
      return backend.votes === undefined ? Promise.resolve([]) : backend.votes(approvalKey);
    },
    async consume(approvalKey: string, by: string): Promise<boolean> {
      if (backend.consume === undefined) return false;
      const entry = await backend.get(approvalKey);
      if (entry === undefined) return false;
      if (entry.expiresAt !== undefined && entry.expiresAt.getTime() <= Date.now()) {
        auditApproval('approval.expired', AUDIT_ACTOR_TYPES.SYSTEM, 'system', entry, {
          expiresAt: entry.expiresAt.toISOString(),
        });
        emitApproval(APPROVAL_EVENT_TYPES.EXPIRED, entry, { reason: 'expired' });
        return false;
      }
      const ok = await backend.consume(approvalKey, by);
      if (ok) {
        auditApproval('approval.consumed', AUDIT_ACTOR_TYPES.USER, by, entry, {
          ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
        });
        emitApproval(APPROVAL_EVENT_TYPES.CONSUMED, entry, { approver: by });
      }
      return ok;
    },
    async pending(
      action: string,
      args: Record<string, unknown>,
      actor: ToolActor,
      key?: string,
      context: ApprovalRequestContext = {},
    ): Promise<void> {
      const approvalKey = key ?? approvalKeyFor(actor, action, args, context.requestId);
      if ((await backend.get(approvalKey)) !== undefined) return;
      const now = new Date();
      const requestedBy = context.requestedBy ?? actor.onBehalfOf ?? actor.key;
      const entry: PendingApproval = {
        approvalKey,
        action,
        args,
        status: 'pending',
        createdAt: now,
        actorKey: actor.key,
        requestedBy,
        ...(actor.onBehalfOf === '' ? {} : { onBehalfOf: actor.onBehalfOf }),
        actorLabel: actor.label,
        requestHash: requestHashFor(actor, action, args, context.requestId),
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        ...(context.policy === undefined ? {} : { policy: context.policy }),
        requiredApprovals: context.requiredApprovals ?? 1,
        ...(context.approverRoles === undefined ? {} : { approverRoles: context.approverRoles }),
        ...(context.approverGroups === undefined ? {} : { approverGroups: context.approverGroups }),
        ...(context.escalateAfterMs === undefined ? {} : { escalateAfterMs: context.escalateAfterMs }),
        ...(context.escalationApprovers === undefined
          ? {}
          : { escalationApprovers: context.escalationApprovers }),
        approvedCount: 0,
        expiresAt: context.expiresAt ?? new Date(now.getTime() + ttlMs),
      };
      await backend.upsert(entry);
      auditApproval('approval.requested', AUDIT_ACTOR_TYPES.USER, requestedBy, entry, {
        actorKey: actor.key,
        onBehalfOf: actor.onBehalfOf,
        ...(context.policy === undefined ? {} : { policy: context.policy }),
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        expiresAt: entry.expiresAt?.toISOString(),
      });
      emitApproval(APPROVAL_EVENT_TYPES.REQUESTED, entry);
    },
  };
}

export interface ToolExecutorOptions {
  /** RBAC-decorated object data-access the controlled surface wraps */
  dataAccess: ObjectDataAccess;
  /** pool + registry the tool data-access contexts are built on */
  pool: Pool;
  registry: ObjectRegistry;
  audit?: AuditSink;
  /** rate-limit / alert handle (adapter-provided; agent credential scope) */
  guardrails: ToolGuardrails;
  approvals?: ApprovalsQueue;
  /** guardrail policies evaluated before every custom-tool call (empty = no gate) */
  policies?: GuardrailPolicy[];
  /** evidence sink (absent = zero overhead) */
  evidence?: EvidenceSink;
  locale?: Locale;
}

export interface CustomToolExecuteRequest {
  subject: IdentitySubject;
  actor: ToolActor;
  /** audit action, e.g. `mcp.tool.<name>` (protocol binding decides the prefix) */
  action: string;
  /** caller-supplied arguments passed through to the handler ctx */
  args: Record<string, unknown>;
  locale?: Locale;
  /** HTTP request id (audit/evidence correlation) */
  requestId?: string;
  /** distributed trace id (parsed from inbound W3C `traceparent`) */
  traceId?: string;
  /** schema signature (evidence correlation) */
  schemaRevision?: string;
}

/** a compiled, subject-visible custom tool entry (used by `tools/list` merging) */
export interface CustomToolSurfaceEntry {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
}

export interface ToolExecutor {
  /** roles-filtered custom-tool surface for a subject (per-subject cached) */
  surface(subject: IdentitySubject, customTools: ToolDefinition[]): CustomToolSurfaceEntry[];
  /** execute a custom tool with a controlled ctx + auto-audit (+ guardrail policies) */
  execute(def: ToolDefinition, args: Record<string, unknown>, req: CustomToolExecuteRequest): Promise<ToolResult>;
  /** approval queue handle (also exposed as `engine.tools.approvals`) */
  approvals: ToolApprovals;
}

function rolesKey(subject: IdentitySubject): string {
  return `${subject.id}:${[...subject.roles].sort().join(',')}`;
}

function toolsKey(customTools: ToolDefinition[]): string {
  return customTools.map((t) => t.name).sort().join(',');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  const real: ObjectDataAccess = options.dataAccess;
  const audit: AuditSink = options.audit ?? NOOP_AUDIT_SINK;
  const approvals: ApprovalsQueue = options.approvals ?? createApprovals({ audit });
  const surfaceCache = new Map<string, CustomToolSurfaceEntry[]>();

  /** controlled surface over a data-access context (base = pool/registry/locale, + client in tx) */
  function toolDataAccess(base: DataAccessContext): ToolDataAccess {
    return {
      find: (n, o, c) => real.find(n, o as unknown as FindOptions, { ...base, ...c }),
      findOne: (n, id, c) => real.findOne(n, id, { ...base, ...c }),
      create: (n, d, c) => real.create(n, d, { ...base, ...c }),
      update: (n, id, ch, c) => real.update(n, id, ch, { ...base, ...c }),
      delete: (n, id, c) => real.delete(n, id, { ...base, ...c }),
    } as ToolDataAccess;
  }

  /** the ToolCallContext a handler receives for the given data-access base */
  function toolContext(base: DataAccessContext, req: CustomToolExecuteRequest): ToolCallContext {
    const da = toolDataAccess(base);
    return {
      dataAccess: da,
      subject: req.subject,
      actor: req.actor,
      args: req.args,
      action: req.action,
      audit,
      guardrails: options.guardrails,
      approvals,
      withTx: async (fn) => {
        return dataAccessWithTx(base, async (txCtx) => fn(toolContext(txCtx, req)));
      },
    };
  }

  return {
    approvals,
    surface(subject, customTools) {
      const key = `${rolesKey(subject)}:${toolsKey(customTools)}`;
      const hit = surfaceCache.get(key);
      if (hit !== undefined) return hit;
      const roles = new Set(subject.roles);
      const entries = customTools
        .filter((t) => t.roles === undefined || t.roles.some((r) => roles.has(r)))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      surfaceCache.set(key, entries);
      return entries;
    },
    async execute(def, args, req) {
      const base: DataAccessContext = {
        pool: options.pool,
        registry: options.registry,
        principal: userPrincipal(req.subject),
        locale: req.locale ?? options.locale,
        ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
        ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
        ...(req.schemaRevision === undefined ? {} : { schemaRevision: req.schemaRevision }),
      };
      // validate arguments against the declared schema before any policy/handler
      const argCheck = validateToolArgs(args, def.inputSchema);
      if (!argCheck.ok) {
        const locale = req.locale ?? options.locale;
        const err = new SchemaError('tool.args.invalid', { tool: def.name, detail: argCheck.detail }, locale);
        void audit
          .record({
            actorType: AUDIT_ACTOR_TYPES.AGENT,
            actorId: req.actor.key,
            action: req.action,
            objectName: undefined,
            changes: args,
            isError: true,
            errorCode: err.code,
            ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
            ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
            ...(req.subject.scopeId === undefined ? {} : { scopeId: req.subject.scopeId }),
            meta: {
              onBehalfOf: req.actor.onBehalfOf,
              subjectId: req.subject.id,
              roles: req.subject.roles,
              agentLabel: req.actor.label,
              tool: def.name,
            },
            timestamp: new Date(),
          })
          .catch(() => {});
        return { content: [{ type: 'text', text: err.localize(locale ?? DEFAULT_LOCALE) }], isError: true };
      }
      const ctx = toolContext(base, req);
      const started = Date.now();
      const event = (isError: boolean, errorCode?: string, extra?: Record<string, unknown>) => ({
        actorType: AUDIT_ACTOR_TYPES.AGENT,
        actorId: req.actor.key,
        action: req.action,
        objectName: undefined,
        changes: args,
        isError,
        errorCode,
        ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
        ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
        ...(req.subject.scopeId === undefined ? {} : { scopeId: req.subject.scopeId }),
        meta: {
          onBehalfOf: req.actor.onBehalfOf,
          subjectId: req.subject.id,
          roles: req.subject.roles,
          agentLabel: req.actor.label,
          tool: def.name,
          latencyMs: Date.now() - started,
          ...extra,
        },
        timestamp: new Date(),
      });

      // orchestrator: plan → gate (guardrail + approval) → execute → evidence
      const outcome = await runPipeline(
        { action: req.action, args },
        {
          actor: req.actor,
          subject: req.subject,
          ...(req.locale === undefined ? {} : { locale: req.locale }),
          ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
          ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
          ...(req.schemaRevision === undefined ? {} : { schemaRevision: req.schemaRevision }),
        },
        {
          gate: async () => {
            const guardrailCtx: GuardrailContext = {
              actor: req.actor,
              subject: req.subject,
              action: req.action,
              args,
              ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
              dataAccess: toolDataAccess(base),
            };
            const gate = await evaluateCall(options.policies ?? [], approvals, guardrailCtx);
            if (gate.kind === 'allow') {
              return gate.mask === undefined ? { kind: 'allow' } : { kind: 'allow', mask: gate.mask };
            }
            if (gate.kind === 'deny') {
              return { kind: 'deny', reason: gate.reason, errorCode: gate.errorCode };
            }
            return { kind: 'pending', approvalKey: gate.approvalKey };
          },
          execute: () => def.handler(ctx),
          evidence: options.evidence,
        },
      );

      if (outcome.outcome === 'ok') {
        let result = outcome.result as ToolResult;
        if (outcome.mask !== undefined && Object.keys(outcome.mask).length > 0) result = applyMask(result, outcome.mask);
        void audit.record(event(false)).catch(() => {});
        return result;
      }
      if (outcome.outcome === 'pending') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ approvalKey: outcome.approvalKey, status: 'pending' }) }],
          isError: true,
        };
      }
      if (outcome.outcome === 'deny') {
        void audit.record(event(true, outcome.errorCode, { policyReason: outcome.reason })).catch(() => {});
        return { content: [{ type: 'text', text: outcome.reason ?? '' }], isError: true };
      }
      // error
      const error = outcome.error;
      const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
      void audit.record(event(true, code)).catch(() => {});
      return { content: [{ type: 'text', text: errorText(error) }], isError: true };
    },
  };
}

export type { ToolApprovals, ApprovalStatus, PendingApproval };
