import type { FastifyInstance } from 'fastify';
import type { AuditFilter, AuditQuery } from '../../core/audit/index.js';
import type { Locale } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import { resolvePagination } from '../../runtime/data-access/index.js';
import type { RestDeps, RestOptions } from './plugin.js';
import { authenticateRequest, checkRateLimit, readDate, readInt, readString } from './common.js';

/** read a JSON object query param (`filter`); non-object → http.param.invalid */
function readFilterObject(
  query: Record<string, unknown>,
  key: string,
  locale: Locale,
): AuditFilter | undefined {
  const raw = readString(query, key, locale);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SchemaError('http.param.invalid', { param: key }, locale);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SchemaError('http.param.invalid', { param: key }, locale);
  }
  return parsed as AuditFilter;
}

/**
 * Audit route (M11, framework-agnostic): paginated audit trail for frontend
 * audit pages (react-admin audit page / Refine `auditLogProvider`).
 *   GET {prefix}/audit?actorId&action&object&from&to&limit&offset
 *
 * RBAC filter (D15): audit rows carry before/after snapshots, so a regular
 * identity only sees its own records (`actorId` defaults to its own id).
 * Roles listed in `options.adminRoles` may query any actor (or the whole
 * trail by omitting `actorId`). Not registered when the audit subsystem is
 * disabled (disabled = not imported = zero overhead).
 */
export function registerAuditRoutes(app: FastifyInstance, deps: RestDeps, options: RestOptions = {}): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale } = deps;
  const limiter = options.rateLimiter;
  const audit = deps.audit;
  if (audit === undefined) return;

  const adminRoles = new Set(options.adminRoles ?? []);

  app.get(`${prefix}/audit`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const query = request.query as Record<string, unknown>;

    const isAdmin = subject.roles.some((r) => adminRoles.has(r));
    const rawActor = readString(query, 'actorId', locale);
    const filter: AuditQuery = {};
    if (rawActor !== undefined) {
      if (rawActor !== subject.id && !isAdmin) {
        throw new SchemaError('audit.denied.actor', {}, locale);
      }
      filter.actorId = rawActor;
    } else if (!isAdmin) {
      filter.actorId = subject.id;
    }

    const action = readString(query, 'action', locale);
    if (action !== undefined) filter.action = action;
    const object = readString(query, 'object', locale);
    if (object !== undefined) filter.object = object;
    const from = readDate(query, 'from', locale);
    if (from !== undefined) filter.from = from;
    const to = readDate(query, 'to', locale);
    if (to !== undefined) filter.to = to;
    const filterObj = readFilterObject(query, 'filter', locale);
    if (filterObj !== undefined) filter.filter = filterObj;
    const { limit, offset } = resolvePagination({
      limit: readInt(query, 'limit', locale),
      offset: readInt(query, 'offset', locale),
    });
    filter.limit = limit;
    filter.offset = offset;

    const { rows, total } = await audit.query(filter);
    return { rows, total, limit, offset };
  });
}
