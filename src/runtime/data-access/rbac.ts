import type { ObjectDefinition } from '../../core/index.js';
import { DETAILS_COLUMNS, SchemaError, primaryFieldsOf, recordKeySql } from '../../core/index.js';
import type { Locale } from '../../core/index.js';
import {
  assertCanCreate,
  assertCanDelete,
  assertCanUpdate,
  buildRowScope,
  buildRowScopeFor,
  resolvePermissionFor,
} from '../../core/index.js';
import type { AuditSink } from '../../core/audit/index.js';
import { AUDIT_ACTOR_TYPES, DATA_ACTIONS } from '../../core/audit/index.js';
import type { DataAccessContext, FindOptions, FindResult, ObjectDataAccess } from './types.js';
import type { ReadScope } from '../../core/index.js';
import { scopeSuffix } from './builder.js';

const q = (id: string) => `"${id}"`;

function deniedCreate(object: string, role: string, locale?: Locale): never {
  throw new SchemaError('rbac.denied.create', { object, role }, locale);
}

/**
 * For a direct details-child create, the referenced `parent_id` must point at a
 * parent row the subject can read (within the parent's row scope). Nested child
 * writes go through the parent's own create (which already enforces this).
 */
async function assertChildParentInScope(
  ctx: DataAccessContext,
  def: ObjectDefinition,
  data: Record<string, unknown>,
): Promise<void> {
  const parentName = def.detailsParent;
  if (parentName === undefined || ctx.subject === undefined) return;
  const parent = ctx.registry.get(parentName);
  if (parent === undefined) return;
  const role = ctx.subject.roles.join(',');
  const parentId = data[DETAILS_COLUMNS.PARENT_ID];
  const pp = resolvePermissionFor(ctx.registry, parent, ctx.subject.roles);
  if (pp === undefined || pp.read === undefined || parentId === undefined || parentId === null) {
    deniedCreate(def.name, role, ctx.locale);
  }
  const scope = buildRowScope(parent, pp.read, ctx.subject, ctx.subject.roles, ctx.locale);
  const rk = recordKeySql(parent, (field) => q(field));
  let sql = `SELECT 1 FROM ${q(parent.name)} WHERE ${rk} = $1`;
  const params: unknown[] = [String(parentId)];
  if (scope !== undefined) {
    const scoped = scopeSuffix(scope, params.length);
    sql = `${sql} AND (${scoped.sql})`;
    params.push(...scoped.params);
  }
  const res = await ctx.pool.query(`${sql} LIMIT 1`, params);
  if (res.rowCount === 0) deniedCreate(def.name, role, ctx.locale);
}

function requireDef(ctx: DataAccessContext, objectName: string): ObjectDefinition {
  const def = ctx.registry.get(objectName);
  if (def === undefined) throw new SchemaError('data.objectUnknown', { object: objectName }, ctx.locale);
  return def;
}

/** record an RBAC denial event (fire-and-forget — audit never blocks the business path) */
function denied(
  sink: AuditSink | undefined,
  ctx: DataAccessContext,
  action: string,
  objectName: string,
  objectId: string | undefined,
  error: unknown,
): void {
  if (sink === undefined) return;
  void sink.record({
    actorType: ctx.subject !== undefined ? AUDIT_ACTOR_TYPES.USER : AUDIT_ACTOR_TYPES.SYSTEM,
    actorId: ctx.subject?.id ?? 'system',
    action,
    objectName,
    objectId,
    isError: true,
    errorCode: error instanceof SchemaError ? error.code : undefined,
    timestamp: new Date(),
  });
}

/** strip RBAC-hidden fields from a returned record */
function strip<T>(record: T, exclude: readonly string[]): T {
  if (exclude.length === 0 || record === null || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }
  const out = { ...(record as Record<string, unknown>) };
  for (const f of exclude) delete out[f];
  return out as T;
}

function scopedCtx(ctx: DataAccessContext, objectName: string, read: ReadScope | undefined): DataAccessContext {
  if (read === undefined || ctx.subject === undefined) return ctx;
  const def = requireDef(ctx, objectName);
  const rowScope = buildRowScopeFor(ctx.registry, def, read, ctx.subject, ctx.subject.roles, ctx.locale);
  return { ...ctx, rowScope };
}

/**
 * Decorate an object data-access with RBAC enforcement.
 *
 * Reads the authenticated `subject` from the execution context and:
 * - find/findOne: injects the row-level scope and excludes hidden fields
 * - create/update/delete: authorizes the operation, filters update changes to
 *   the allowed field set, and scopes update/delete to the read row scope
 * - no subject → pass-through (unrestricted, for internal/admin use)
 */
export function withRbac(inner: ObjectDataAccess, options: { audit?: AuditSink } = {}): ObjectDataAccess {
  const { audit } = options;
  return {
    async find<T>(
      objectName: string,
      opts: FindOptions,
      ctx: DataAccessContext,
    ): Promise<FindResult<T>> {
      if (ctx.subject === undefined) return inner.find<T>(objectName, opts, ctx);
      const def = requireDef(ctx, objectName);
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      if (p === undefined || p.read === undefined) {
        const err = new SchemaError('rbac.denied.read', { object: objectName, role: ctx.subject.roles.join(',') }, ctx.locale);
        denied(audit, ctx, DATA_ACTIONS.READ, objectName, undefined, err);
        throw err;
      }
      return inner.find<T>(objectName, { ...opts, exclude: p.exclude }, scopedCtx(ctx, objectName, p.read));
    },

    async findOne<T>(
      objectName: string,
      id: string,
      ctx: DataAccessContext,
    ): Promise<T | null> {
      if (ctx.subject === undefined) return inner.findOne<T>(objectName, id, ctx);
      const def = requireDef(ctx, objectName);
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      if (p === undefined || p.read === undefined) {
        const err = new SchemaError('rbac.denied.read', { object: objectName, role: ctx.subject.roles.join(',') }, ctx.locale);
        denied(audit, ctx, DATA_ACTIONS.READ, objectName, id, err);
        throw err;
      }
      const record = await inner.findOne<T>(objectName, id, scopedCtx(ctx, objectName, p.read));
      return record === null ? null : strip(record, p.exclude);
    },

    async create<T>(
      objectName: string,
      data: Record<string, unknown>,
      ctx: DataAccessContext,
    ): Promise<T> {
      if (ctx.subject === undefined) return inner.create<T>(objectName, data, ctx);
      const def = requireDef(ctx, objectName);
      try {
        assertCanCreate(def, ctx.subject.roles, ctx.locale, ctx.registry);
      } catch (error) {
        denied(audit, ctx, DATA_ACTIONS.CREATE, objectName, undefined, error);
        throw error;
      }
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      // a direct details-child create must attach to a parent row in scope
      await assertChildParentInScope(ctx, def, data);
      // `p.createFields === null` means "all writable fields allowed on create"
      // (no fields.create declared); otherwise only the whitelist is accepted
      let payload = data;
      const allowed = p?.createFields ?? null;
      const primaryKeys = new Set(primaryFieldsOf(def).map((f) => f.name));
      if (allowed !== null) {
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
          if (primaryKeys.has(key)) {
            filtered[key] = value;
            continue;
          }
          if (!allowed.includes(key)) {
            const err = new SchemaError('rbac.denied.field', { object: objectName, role: ctx.subject.roles.join(','), field: key }, ctx.locale);
            denied(audit, ctx, DATA_ACTIONS.CREATE, objectName, undefined, err);
            throw err;
          }
          filtered[key] = value;
        }
        payload = filtered;
      }
      const record = await inner.create<T>(objectName, payload, ctx);
      return strip(record, p?.exclude ?? []);
    },

    async update<T>(
      objectName: string,
      id: string,
      changes: Record<string, unknown>,
      ctx: DataAccessContext,
    ): Promise<T> {
      if (ctx.subject === undefined) return inner.update<T>(objectName, id, changes, ctx);
      const def = requireDef(ctx, objectName);
      try {
        assertCanUpdate(def, ctx.subject.roles, ctx.locale, ctx.registry);
      } catch (error) {
        denied(audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, error);
        throw error;
      }
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      // fail-closed: without a read scope we cannot derive a row scope, so an
      // update would silently target any row — deny instead
      if (p?.read === undefined) {
        const err = new SchemaError('rbac.denied.update', { object: objectName, role: ctx.subject.roles.join(',') }, ctx.locale);
        denied(audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, err);
        throw err;
      }
      // `p.update === null` means "all fields updatable" (open mode / update: true) —
      // keep the null sentinel; `?? []` would collapse it and deny every field
      const allowed = p.update;
      const primaryNames = new Set(primaryFieldsOf(def).map((f) => f.name));
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (primaryNames.has(key)) {
          const err = new SchemaError('object.primary.mutable', { object: objectName, field: key }, ctx.locale);
          denied(audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, err);
          throw err;
        }
        if (allowed !== null && !allowed.includes(key)) {
          const err = new SchemaError('rbac.denied.field', { object: objectName, role: ctx.subject.roles.join(','), field: key }, ctx.locale);
          denied(audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, err);
          throw err;
        }
        filtered[key] = value;
      }
      const record = await inner.update<T>(objectName, id, filtered, scopedCtx(ctx, objectName, p?.manage ?? p?.read));
      return strip(record, p?.exclude ?? []);
    },

    async transition<T>(
      objectName: string,
      id: string,
      action: string,
      ctx: DataAccessContext,
      payload?: Record<string, unknown>,
    ): Promise<T> {
      if (ctx.subject === undefined) return inner.transition<T>(objectName, id, action, ctx, payload);
      const def = requireDef(ctx, objectName);
      try {
        assertCanUpdate(def, ctx.subject.roles, ctx.locale, ctx.registry);
      } catch (error) {
        denied(audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, error);
        throw error;
      }
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      if (p?.read === undefined) {
        const err = new SchemaError('rbac.denied.update', { object: objectName, role: ctx.subject.roles.join(',') }, ctx.locale);
        denied(audit, ctx, DATA_ACTIONS.UPDATE, objectName, id, err);
        throw err;
      }
      const record = await inner.transition<T>(objectName, id, action, scopedCtx(ctx, objectName, p.manage ?? p.read), payload);
      return strip(record, p?.exclude ?? []);
    },

    async workflowStatus(objectName: string, id: string, ctx: DataAccessContext) {
      if (ctx.subject === undefined) return inner.workflowStatus(objectName, id, ctx);
      const def = requireDef(ctx, objectName);
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      if (p === undefined || p.read === undefined) {
        const err = new SchemaError('rbac.denied.read', { object: objectName, role: ctx.subject.roles.join(',') }, ctx.locale);
        denied(audit, ctx, DATA_ACTIONS.READ, objectName, id, err);
        throw err;
      }
      return inner.workflowStatus(objectName, id, scopedCtx(ctx, objectName, p.read));
    },

    async acquireWorkflowLock(objectName: string, id: string, ctx: DataAccessContext) {
      if (ctx.subject === undefined) return inner.acquireWorkflowLock(objectName, id, ctx);
      const def = requireDef(ctx, objectName);
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      if (p === undefined || p.read === undefined) {
        const err = new SchemaError('rbac.denied.read', { object: objectName, role: ctx.subject.roles.join(',') }, ctx.locale);
        denied(audit, ctx, DATA_ACTIONS.READ, objectName, id, err);
        throw err;
      }
      return inner.acquireWorkflowLock(objectName, id, scopedCtx(ctx, objectName, p.read));
    },

    async releaseWorkflowLock(objectName: string, id: string, ctx: DataAccessContext): Promise<void> {
      return inner.releaseWorkflowLock(objectName, id, ctx);
    },

    async workflowHistory(objectName: string, id: string, ctx: DataAccessContext) {
      if (ctx.subject === undefined) return inner.workflowHistory(objectName, id, ctx);
      const def = requireDef(ctx, objectName);
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      if (p === undefined || p.read === undefined) {
        const err = new SchemaError('rbac.denied.read', { object: objectName, role: ctx.subject.roles.join(',') }, ctx.locale);
        denied(audit, ctx, DATA_ACTIONS.READ, objectName, id, err);
        throw err;
      }
      return inner.workflowHistory(objectName, id, scopedCtx(ctx, objectName, p.read));
    },

    async workflowTodos(ctx: DataAccessContext) {
      return inner.workflowTodos(ctx);
    },

    async delete(objectName: string, id: string, ctx: DataAccessContext): Promise<void> {
      if (ctx.subject === undefined) return inner.delete(objectName, id, ctx);
      const def = requireDef(ctx, objectName);
      try {
        assertCanDelete(def, ctx.subject.roles, ctx.locale, ctx.registry);
      } catch (error) {
        denied(audit, ctx, DATA_ACTIONS.DELETE, objectName, id, error);
        throw error;
      }
      const p = resolvePermissionFor(ctx.registry, def, ctx.subject.roles);
      // fail-closed: same as update — no read scope means no row scope
      if (p?.read === undefined) {
        const err = new SchemaError('rbac.denied.delete', { object: objectName, role: ctx.subject.roles.join(',') }, ctx.locale);
        denied(audit, ctx, DATA_ACTIONS.DELETE, objectName, id, err);
        throw err;
      }
      return inner.delete(objectName, id, scopedCtx(ctx, objectName, p.manage ?? p.read));
    },
  };
}
