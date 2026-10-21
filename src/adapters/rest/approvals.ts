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

type EligibilityFilter = ApprovalListFilter & {
  pendingForRoles?: string[];
};

function parseFilter(query: Record<string, unknown>, locale: Locale): EligibilityFilter {
  const filter: ApprovalListFilter = {};
  const status = parseStatus(readString(query, 'status', locale), locale);
  if (status !== undefined) filter.status = status;
  const action = readString(query, 'action', locale);
  if (action !== undefined) filter.action = action;
  const actorKey = readString(query, 'actorKey', locale);
  if (actorKey !== undefined) filter.actorKey = actorKey;
  const requestedBy = readString(query, 'requestedBy', locale);
  if (requestedBy !== undefined) filter.requestedBy = requestedBy;
  const approvalKey = readString(query, 'approvalKey', locale);
  if (approvalKey !== undefined) filter.approvalKey = approvalKey;
  const pendingFor = readString(query, 'pendingFor', locale);
  if (pendingFor !== undefined) filter.pendingFor = pendingFor;
  const from = readDate(query, 'from', locale);
  if (from !== undefined) filter.from = from;
  const to = readDate(query, 'to', locale);
  if (to !== undefined) filter.to = to;
  const expiresBefore = readDate(query, 'expiresBefore', locale);
  if (expiresBefore !== undefined) filter.expiresBefore = expiresBefore;
  const sort = readString(query, 'sort', locale);
  if (sort !== undefined) {
    filter.sort = { field: sort, order: readString(query, 'order', locale) === 'ASC' ? 'ASC' : 'DESC' };
  }
  return filter;
}

/**
 * Approval queue routes (depth-1 read + local write; MCP tools deferred):
 *   GET  {prefix}/approvals — paged list with status/action/actorKey/time filters
 *   POST {prefix}/approvals/:key/approve — resolve a pending entry (admin)
 *   POST {prefix}/approvals/:key/reject — resolve a pending entry (admin)
 *
 * Reads and writes are gated to `adminRoles` (the queue carries request args —
 * a write authority boundary). Approver id comes from the authenticated subject;
 * resolution is audited by the queue facade. Cross-instance remote
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
    if (filter.pendingFor !== undefined) {
      filter.pendingFor = subject.id;
      filter.pendingForRoles = subject.roles;
    }
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
      const body = (request.body ?? {}) as { comment?: unknown };
      const comment =
        typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : undefined;
      if (decision === 'rejected' && comment === undefined) {
        throw new SchemaError('http.param.invalid', { param: 'comment' }, locale);
      }
      const [current] = await approvals.list({ approvalKey: key, limit: 1 });
      if (current?.requestedBy !== undefined && current.requestedBy === subject.id) {
        throw new SchemaError(
          'http.conflict',
          { detail: 'segregation of duties: the requester cannot decide their own approval' },
          locale,
        );
      }
      const ok =
        decision === 'approved'
          ? await approvals.approve(key, subject.id, comment)
          : await approvals.reject(key, subject.id, comment);
      if (!ok) {
        throw new SchemaError('approval.notFound', { approvalKey: key }, locale);
      }
      const [entry] = await approvals.list({ approvalKey: key, limit: 1 });
      return {
        approvalKey: key,
        status: entry?.status ?? decision,
        approvedCount: entry?.approvedCount ?? 0,
        requiredApprovals: entry?.requiredApprovals ?? 1,
        approver: subject.id,
        ...(comment === undefined ? {} : { comment }),
      };
    };

  const decisionRoute = async (request: FastifyRequest) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdminRoles(subject.roles);
    const { key } = request.params as { key: string };
    const body = (request.body ?? {}) as { decision?: unknown; comment?: unknown };
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      throw new SchemaError('http.param.invalid', { param: 'decision' }, locale);
    }
    const comment =
      typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : undefined;
    if (body.decision === 'rejected' && comment === undefined) {
      throw new SchemaError('http.param.invalid', { param: 'comment' }, locale);
    }
    const [current] = await approvals.list({ approvalKey: key, limit: 1 });
    if (current?.requestedBy !== undefined && current.requestedBy === subject.id) {
      throw new SchemaError(
        'http.conflict',
        { detail: 'segregation of duties: the requester cannot decide their own approval' },
        locale,
      );
    }
    const ok = await approvals.vote(key, {
      approvalKey: key,
      approver: subject.id,
      decision: body.decision,
      ...(comment === undefined ? {} : { comment }),
      stage: 0,
      createdAt: new Date(),
    });
    if (!ok) throw new SchemaError('approval.notFound', { approvalKey: key }, locale);
    const [entry] = await approvals.list({ approvalKey: key, limit: 1 });
    return {
      approvalKey: key,
      status: entry?.status ?? 'pending',
      approvedCount: entry?.approvedCount ?? 0,
      requiredApprovals: entry?.requiredApprovals ?? 1,
      approver: subject.id,
      ...(comment === undefined ? {} : { comment }),
    };
  };

  app.post(`${prefix}/approvals/:key/approve`, resolveRoute('approved'));
  app.post(`${prefix}/approvals/:key/reject`, resolveRoute('rejected'));
  app.post(`${prefix}/approvals/:key/decisions`, decisionRoute);

  app.get(`${prefix}/approvals/:key/votes`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdminRoles(subject.roles);
    const { key } = request.params as { key: string };
    return { approvalKey: key, votes: await approvals.votes(key) };
  });
}
