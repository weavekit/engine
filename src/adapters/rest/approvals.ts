import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApprovalListFilter, ApprovalStatus } from '../../core/tools/index.js';
import { APPROVAL_STATUSES, SchemaError, type Locale } from '../../core/index.js';
import { resolvePagination } from '../../runtime/data-access/index.js';
import type { RestDeps, RestOptions } from './plugin.js';
import {
  authenticateRequest,
  checkRateLimit,
  readDate,
  readInt,
  readString,
  requireAdmin,
} from './common.js';

const VALID_STATUSES = new Set<string>(Object.values(APPROVAL_STATUSES));

function parseStatus(raw: string | undefined, locale: Locale): ApprovalStatus | undefined {
  if (raw === undefined) return undefined;
  if (!VALID_STATUSES.has(raw)) throw new SchemaError('http.param.invalid', { param: 'status' }, locale);
  return raw as ApprovalStatus;
}

function parseFilter(query: Record<string, unknown>, locale: Locale): ApprovalListFilter {
  const filter: ApprovalListFilter = {};
  const status = parseStatus(readString(query, 'status', locale), locale);
  if (status !== undefined) filter.status = status;
  const action = readString(query, 'action', locale);
  if (action !== undefined) filter.action = action;
  const actorKey = readString(query, 'actorKey', locale);
  if (actorKey !== undefined) filter.actorKey = actorKey;
  const from = readDate(query, 'from', locale);
  if (from !== undefined) filter.from = from;
  const to = readDate(query, 'to', locale);
  if (to !== undefined) filter.to = to;
  const sort = readString(query, 'sort', locale);
  if (sort !== undefined) {
    filter.sort = { field: sort, order: readString(query, 'order', locale) === 'ASC' ? 'ASC' : 'DESC' };
  }
  return filter;
}

/**
 * Approval queue routes (D1 depth-1 read + local write; MCP tools deferred):
 *   GET  {prefix}/approvals — paged list with status/action/actorKey/time filters
 *   POST {prefix}/approvals/:key/approve — resolve a pending entry (admin)
 *   POST {prefix}/approvals/:key/reject — resolve a pending entry (admin)
 *
 * Reads and writes are gated to `adminRoles` (the queue carries request args —
 * a write authority boundary). Approver id comes from the authenticated subject;
 * resolution is audited (A7) by the queue facade. Cross-instance remote
 * approve/reject (depth 2) is not implemented.
 */
export function registerApprovalsRoutes(app: FastifyInstance, deps: RestDeps, options: RestOptions = {}): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale } = deps;
  const limiter = options.rateLimiter;
  const approvals = deps.approvals;
  if (approvals === undefined) return;

  const requireAdminRoles = (roles: string[]): void =>
    requireAdmin(roles, 'approvals', options.adminRoles, locale);

  app.get(`${prefix}/approvals`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdminRoles(subject.roles);
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query, locale);
    const { limit, offset } = resolvePagination({
      limit: readInt(query, 'limit', locale),
      offset: readInt(query, 'offset', locale),
    });
    filter.limit = limit;
    filter.offset = offset;
    const [rows, total] = await Promise.all([approvals.list(filter), approvals.count(filter)]);
    return { rows, total, limit, offset };
  });

  const resolveRoute =
    (decision: 'approved' | 'rejected') =>
    async (request: FastifyRequest) => {
      checkRateLimit(limiter, request, locale);
      const subject = await authenticateRequest(authenticator, request, locale);
      requireAdminRoles(subject.roles);
      const { key } = request.params as { key: string };
      const ok =
        decision === 'approved' ? await approvals.approve(key, subject.id) : await approvals.reject(key, subject.id);
      if (!ok) {
        throw new SchemaError('approval.notFound', { approvalKey: key }, locale);
      }
      return { approvalKey: key, status: decision, approver: subject.id };
    };

  app.post(`${prefix}/approvals/:key/approve`, resolveRoute('approved'));
  app.post(`${prefix}/approvals/:key/reject`, resolveRoute('rejected'));
}
