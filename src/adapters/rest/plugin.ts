import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Locale, ObjectRegistry } from "../../core/index.js";
import { SchemaError } from "../../core/index.js";
import type { AuditQueryEngine } from "../../core/audit/index.js";
import type { ToolApprovals } from "../../core/tools/index.js";
import type { SlidingWindow } from "../../core/limiter/index.js";
import type {
  FindOptions,
  ObjectDataAccess,
} from "../../runtime/data-access/index.js";
import {
  SORT_DIRS,
  resolvePagination,
  withTx,
} from "../../runtime/data-access/index.js";
import { parseFindParams, type ListQuery } from "../../core/api/index.js";
import type { Authenticator } from "../auth/index.js";
import type { DataAccessContext } from "../../runtime/data-access/index.js";
import { authenticateRequest, checkRateLimit } from "./common.js";

/** everything the REST layer needs to serve a request */
export interface RestDeps {
  registry: ObjectRegistry;
  pool: Pool;
  dataAccess: ObjectDataAccess;
  authenticator: Authenticator;
  locale: Locale;
  /** audit query engine; present when the audit subsystem is enabled — registers `GET {prefix}/audit` */
  audit?: AuditQueryEngine;
  /** approval queue; present when the tool executor is enabled — registers `/approvals` routes */
  approvals?: ToolApprovals;
}

export interface RestOptions {
  /** URL prefix for object routes; defaults to `/api` */
  prefix?: string;
  /** per-agent-key sliding-window limiter; disabled when absent */
  rateLimiter?: SlidingWindow;
  /** roles allowed to query the full audit trail and use admin script-source read/write routes */
  adminRoles?: string[];
}

/** drop `sensitive` fields from a REST-read row — secrets never reach the browser. */
function maskSensitiveRow(
  registry: ObjectRegistry,
  objectName: string,
  record: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (record === null || record === undefined) return record;
  const def = registry.get(objectName);
  if (def === undefined) return record;
  for (const field of def.fields) {
    if (field.sensitive === true) delete record[field.name];
  }
  return record;
}

function maskSensitiveRows(
  registry: ObjectRegistry,
  objectName: string,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map((row) => maskSensitiveRow(registry, objectName, row) as Record<string, unknown>);
}

function bodyObject(body: unknown, locale: Locale): Record<string, unknown> {
  if (body === undefined) return {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new SchemaError("http.param.invalid", { param: "body" }, locale);
  }
  return body as Record<string, unknown>;
}

/** parse a non-empty, deduplicated array of record ids (string or number) */
function parseIds(body: Record<string, unknown>, locale: Locale): string[] {
  const raw = body.ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SchemaError("http.param.invalid", { param: "ids" }, locale);
  }
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new SchemaError("http.param.invalid", { param: "ids" }, locale);
    }
    const s = String(value);
    if (!ids.includes(s)) ids.push(s);
  }
  return ids;
}

/** the update changeset must be a plain object (validation happens per-record inside the tx) */
function parseChanges(
  body: Record<string, unknown>,
  locale: Locale,
): Record<string, unknown> {
  const changes = body.changes;
  if (
    changes === null ||
    typeof changes !== "object" ||
    Array.isArray(changes)
  ) {
    throw new SchemaError("http.param.invalid", { param: "changes" }, locale);
  }
  return changes as Record<string, unknown>;
}

/** map a parsed {@link ListQuery} onto the data-access FindOptions (domain validation here) */
function toFindOptions(list: ListQuery, locale: Locale): FindOptions {
  const options: FindOptions = {};
  if (list.filter !== undefined) options.filter = list.filter;
  if (list.fields !== undefined) options.fields = list.fields;
  if (list.limit !== undefined) options.limit = list.limit;
  if (list.offset !== undefined) options.offset = list.offset;
  if (list.sort !== undefined) {
    const sort: FindOptions["sort"] = [];
    for (const s of list.sort) {
      if (s.direction !== SORT_DIRS.ASC && s.direction !== SORT_DIRS.DESC) {
        throw new SchemaError("http.param.invalid", { param: "sort" }, locale);
      }
      sort.push({ field: s.field, dir: s.direction });
    }
    options.sort = sort;
  }
  return options;
}

/**
 * Register the generic object CRUD routes on a fastify app:
 *   GET    {prefix}/objects/:name
 *   POST   {prefix}/objects/:name
 *   GET    {prefix}/objects/:name/:id
 *   PATCH  {prefix}/objects/:name/:id
 *   DELETE {prefix}/objects/:name/:id
 *
 * Routes are parameterized by object name (not registered per object), so the
 * registry may change without re-registering routes. Every request is
 * authenticated and runs through the RBAC-decorated data-access layer.
 */
export function registerObjectRoutes(
  app: FastifyInstance,
  deps: RestDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? "/api";
  const { registry, pool, dataAccess, authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/objects/:name`, async (request) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const ctx: DataAccessContext = { pool, registry, subject, locale };
    const list = parseFindParams(
      request.query as Record<string, unknown>,
      locale,
    );
    const opts = toFindOptions(list, locale);
    const { rows, total } = await dataAccess.find(name, opts, ctx);
    const { limit, offset } = resolvePagination(opts);
    return { rows: maskSensitiveRows(registry, name, rows), total, limit, offset };
  });

  app.post(`${prefix}/objects/:name`, async (request, reply) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const warnings: string[] = [];
    const ctx: DataAccessContext = {
      pool,
      registry,
      subject,
      locale,
      onWarnings: (ws) => warnings.push(...ws),
    };
    const record = await dataAccess.create(
      name,
      bodyObject(request.body, locale),
      ctx,
    );
    const masked = maskSensitiveRow(registry, name, record);
    return reply
      .code(201)
      .send(warnings.length > 0 ? { ...masked, warnings } : masked);
  });

  app.get(`${prefix}/objects/:name/:id`, async (request) => {
    const { name, id } = request.params as { name: string; id: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const ctx: DataAccessContext = { pool, registry, subject, locale };
    const record = await dataAccess.findOne(name, id, ctx);
    if (record === null) {
      throw new SchemaError(
        "data.recordNotFound",
        { object: name, id },
        locale,
      );
    }
    return maskSensitiveRow(registry, name, record);
  });

  app.patch(`${prefix}/objects/:name/:id`, async (request) => {
    const { name, id } = request.params as { name: string; id: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const warnings: string[] = [];
    const ctx: DataAccessContext = {
      pool,
      registry,
      subject,
      locale,
      onWarnings: (ws) => warnings.push(...ws),
    };
    const record = await dataAccess.update(
      name,
      id,
      bodyObject(request.body, locale),
      ctx,
    );
    const masked = maskSensitiveRow(registry, name, record);
    return warnings.length > 0 ? { ...masked, warnings } : masked;
  });

  app.delete(`${prefix}/objects/:name/:id`, async (request, reply) => {
    const { name, id } = request.params as { name: string; id: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const ctx: DataAccessContext = { pool, registry, subject, locale };
    await dataAccess.delete(name, id, ctx);
    reply.code(204).send();
  });

  // Atomic batch operations (RA updateMany/deleteMany): one transaction over
  // the per-record write path, so per-record validation / script hooks /
  // audit / RBAC row-scope all apply and a failure rolls back the whole batch
  // (all-or-nothing). Auth runs once; the loop reuses the tx client.
  app.patch(`${prefix}/objects/:name`, async (request) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const body = bodyObject(request.body, locale);
    const ids = parseIds(body, locale);
    const changes = parseChanges(body, locale);
    const warnings: string[] = [];
    const ctx: DataAccessContext = {
      pool,
      registry,
      subject,
      locale,
      onWarnings: (ws) => warnings.push(...ws),
    };
    await withTx(ctx, async (txCtx) => {
      for (const id of ids) {
        await dataAccess.update(name, id, changes, txCtx);
      }
    });
    return warnings.length > 0 ? { updated: ids, warnings } : { updated: ids };
  });

  app.delete(`${prefix}/objects/:name`, async (request) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const ids = parseIds(bodyObject(request.body, locale), locale);
    const ctx: DataAccessContext = { pool, registry, subject, locale };
    await withTx(ctx, async (txCtx) => {
      for (const id of ids) {
        await dataAccess.delete(name, id, txCtx);
      }
    });
    return { deleted: ids };
  });
}
