import type { ObjectDefinition, RbacSubject } from '../../core/index.js';
import { REGISTRY_TOOLS, SchemaError } from '../../core/index.js';
import type { DataAccessContext } from '../../runtime/data-access/index.js';
import type { FindOptions } from '../../runtime/data-access/index.js';
import { SORT_DIRS, resolvePagination } from '../../runtime/data-access/index.js';
import type { AuditEvent } from '../../core/audit/index.js';
import { ACTION_PREFIXES, AUDIT_ACTOR_TYPES } from '../../core/audit/index.js';
import type { McpToolResult, ToolExecContext } from './types.js';

/**
 * Tool execution handlers for the generic registry surface. Every call:
 *  - resolves the target object from the `object` argument (unknown → `isError`)
 *  - resolves the effective subject (session.user, or the on-behalf-of override)
 *  - runs through the RBAC-decorated data-access layer (double layer — the
 *    capability was already gated at compile time, and RBAC re-checks it here)
 *  - audits the attempt (success or failure) through the injected sink
 *  - maps SchemaError → `isError` result with a localized message
 */

const ON_BEHALF_OF = 'onBehalfOf';

function ctxWithSubject(ctx: ToolExecContext, subject: RbacSubject): DataAccessContext {
  return { pool: ctx.engine.pool, registry: ctx.engine.registry, subject, locale: ctx.engine.locale };
}

/** call-level `onBehalfOf` override: resolve a different identity for this call */
async function effectiveSubject(args: Record<string, unknown>, ctx: ToolExecContext): Promise<RbacSubject> {
  const override = args[ON_BEHALF_OF];
  if (override === undefined) return ctx.session.user;
  const resolved = await ctx.resolveIdentity(String(override));
  if (resolved === null) {
    throw new SchemaError('mcp.identity.unknown', { ref: String(override) }, ctx.engine.locale);
  }
  return resolved;
}

/** the `object` argument as requested (for audit; may be unknown) */
function requestedObject(args: Record<string, unknown>): string | undefined {
  return args.object === undefined ? undefined : String(args.object);
}

/** resolve the target object by name (unknown → data.objectUnknown, mapped to isError) */
function resolveObject(ctx: ToolExecContext, args: Record<string, unknown>): ObjectDefinition {
  const name = String(args.object ?? '');
  const def = ctx.engine.registry.get(name);
  if (def === undefined) {
    throw new SchemaError('data.objectUnknown', { object: name }, ctx.engine.locale);
  }
  return def;
}

/** audit one tool attempt (fire-and-forget, failure-tolerant) */
function auditToolCall(
  ctx: ToolExecContext,
  tool: string,
  objectName: string | undefined,
  subject: RbacSubject,
  args: Record<string, unknown>,
  isError: boolean,
  errorCode: string | undefined,
  errorDetail?: string,
): void {
  const { agentKey, agentSubject, onBehalfOf } = ctx.session;
  const changes: Record<string, unknown> = { ...args };
  delete changes[ON_BEHALF_OF];
  const event: AuditEvent = {
    actorType: AUDIT_ACTOR_TYPES.AGENT,
    actorId: agentKey,
    action: `${ACTION_PREFIXES.MCP_TOOL}.${tool}`,
    objectName,
    changes,
    isError,
    errorCode,
    meta: {
      onBehalfOf,
      subjectId: subject.id,
      roles: subject.roles,
      agentLabel: agentSubject.id,
      tool,
      // raw failure detail for internal forensics only — never returned to the caller
      ...(errorDetail !== undefined ? { errorDetail } : {}),
    },
    timestamp: new Date(),
  };
  void ctx.guardrails.audit(event);
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function errorResult(error: unknown, ctx: ToolExecContext): McpToolResult {
  if (error instanceof SchemaError) {
    return textResult(error.localize(ctx.engine.locale), true);
  }
  // non-SchemaError (e.g. a raw driver/SQL error) must not leak internals to
  // the caller — return a generic message; the real detail stays in the audit
  // event (meta.errorDetail).
  return textResult(new SchemaError('http.internal', {}, ctx.engine.locale).message, true);
}

async function callProtected(
  ctx: ToolExecContext,
  tool: string,
  objectName: string | undefined,
  args: Record<string, unknown>,
  subject: RbacSubject,
  run: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  if (!ctx.guardrails.checkRateLimit(ctx.session.agentKey)) {
    const msg = new SchemaError('mcp.rateLimited', {}, ctx.engine.locale);
    auditToolCall(ctx, tool, objectName, subject, args, true, msg.code);
    return errorResult(msg, ctx);
  }
  try {
    const result = await run();
    auditToolCall(ctx, tool, objectName, subject, args, false, undefined);
    return result;
  } catch (error) {
    const code = error instanceof SchemaError ? error.code : undefined;
    const detail = error instanceof SchemaError ? undefined : (error instanceof Error ? error.message : String(error));
    auditToolCall(ctx, tool, objectName, subject, args, true, code, detail);
    return errorResult(error, ctx);
  }
}

function toFindOptions(args: Record<string, unknown>): FindOptions {
  const options: FindOptions = {};
  if (args.filter !== undefined && typeof args.filter === 'object') options.filter = args.filter as FindOptions['filter'];
  if (typeof args.limit === 'number') options.limit = args.limit;
  if (typeof args.offset === 'number') options.offset = args.offset;
  if (Array.isArray(args.fields)) options.fields = args.fields as string[];
  if (Array.isArray(args.sort)) {
    options.sort = (args.sort as Array<{ field: string; direction?: string }>).map((s) => ({
      field: s.field,
      dir: s.direction === 'desc' ? SORT_DIRS.DESC : SORT_DIRS.ASC,
    }));
  }
  return options;
}

export async function searchRecordsHandler(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<McpToolResult> {
  const subject = await effectiveSubject(args, ctx);
  return callProtected(ctx, REGISTRY_TOOLS.SEARCH, requestedObject(args), args, subject, async () => {
    const def = resolveObject(ctx, args);
    const { rows, total } = await ctx.engine.dataAccess.find(def.name, toFindOptions(args), ctxWithSubject(ctx, subject));
    const { limit, offset } = resolvePagination(toFindOptions(args));
    return textResult(JSON.stringify({ rows, total, limit, offset }));
  });
}

export async function getRecordHandler(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<McpToolResult> {
  const subject = await effectiveSubject(args, ctx);
  return callProtected(ctx, REGISTRY_TOOLS.GET, requestedObject(args), args, subject, async () => {
    const def = resolveObject(ctx, args);
    const id = String(args.id ?? '');
    const record = await ctx.engine.dataAccess.findOne(def.name, id, ctxWithSubject(ctx, subject));
    if (record === null) {
      throw new SchemaError('data.recordNotFound', { object: def.name, id }, ctx.engine.locale);
    }
    return textResult(JSON.stringify(record));
  });
}

export async function createRecordHandler(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<McpToolResult> {
  const subject = await effectiveSubject(args, ctx);
  return callProtected(ctx, REGISTRY_TOOLS.CREATE, requestedObject(args), args, subject, async () => {
    const def = resolveObject(ctx, args);
    const data = (args.data ?? {}) as Record<string, unknown>;
    const record = await ctx.engine.dataAccess.create(def.name, data, ctxWithSubject(ctx, subject));
    return textResult(JSON.stringify(record));
  });
}

export async function updateRecordHandler(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<McpToolResult> {
  const subject = await effectiveSubject(args, ctx);
  return callProtected(ctx, REGISTRY_TOOLS.UPDATE, requestedObject(args), args, subject, async () => {
    const def = resolveObject(ctx, args);
    const id = String(args.id ?? '');
    const changes = (args.changes ?? {}) as Record<string, unknown>;
    const record = await ctx.engine.dataAccess.update(def.name, id, changes, ctxWithSubject(ctx, subject));
    return textResult(JSON.stringify(record));
  });
}

export async function deleteRecordHandler(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<McpToolResult> {
  const subject = await effectiveSubject(args, ctx);
  return callProtected(ctx, REGISTRY_TOOLS.DELETE, requestedObject(args), args, subject, async () => {
    const def = resolveObject(ctx, args);
    const id = String(args.id ?? '');
    await ctx.engine.dataAccess.delete(def.name, id, ctxWithSubject(ctx, subject));
    return textResult(JSON.stringify({ ok: true, id }));
  });
}
