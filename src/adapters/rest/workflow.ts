import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SchemaError } from '../../core/index.js';
import type { RestDeps, RestOptions } from './plugin.js';
import { authenticateRequest, checkRateLimit } from './common.js';

/** body → optional transition payload (forward `{ to }`, `{ comment }`) */
function payloadOf(body: unknown): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/**
 * Workflow routes for objects that declare `objects/<name>/workflow.json`:
 *   GET    {prefix}/objects/:name/:id/workflow            → status (state/node/actions/workitems)
 *   POST   {prefix}/objects/:name/:id/workflow/:action    → run an action (submit/approve/reject/withdraw/cancel/forward)
 *   POST   {prefix}/objects/:name/:id/workflow/lock       → acquire/renew the caller's presence lock
 *   DELETE {prefix}/objects/:name/:id/workflow/lock       → release the caller's presence lock
 *   POST   {prefix}/objects/:name/:id/transitions/:action → back-compat alias for the action route
 *
 * All are RBAC-scoped via the data-access layer (read for the status/lock,
 * update + workitem participation for actions).
 */
export function registerWorkflowRoutes(
  app: FastifyInstance,
  deps: RestDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale, registry, dataAccess, pool } = deps;
  const limiter = options.rateLimiter;

  const requireWorkflow = (name: string) => {
    const def = registry.get(name);
    if (def === undefined) throw new SchemaError('data.objectUnknown', { object: name }, locale);
    if (def.workflow === undefined) throw new SchemaError('http.notFound', {}, locale);
    return def;
  };

  app.get(`${prefix}/objects/:name/:id/workflow`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { name, id } = request.params as { name: string; id: string };
    requireWorkflow(name);
    return dataAccess.workflowStatus(name, id, { pool, registry, subject, locale });
  });

  app.get(`${prefix}/objects/:name/:id/workflow/history`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { name, id } = request.params as { name: string; id: string };
    requireWorkflow(name);
    return dataAccess.workflowHistory(name, id, { pool, registry, subject, locale });
  });

  app.get(`${prefix}/workflow/todos`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    return { items: await dataAccess.workflowTodos({ pool, registry, subject, locale }) };
  });

  app.post(`${prefix}/objects/:name/:id/workflow/lock`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { name, id } = request.params as { name: string; id: string };
    requireWorkflow(name);
    return dataAccess.acquireWorkflowLock(name, id, { pool, registry, subject, locale });
  });

  app.delete(`${prefix}/objects/:name/:id/workflow/lock`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { name, id } = request.params as { name: string; id: string };
    requireWorkflow(name);
    await dataAccess.releaseWorkflowLock(name, id, { pool, registry, subject, locale });
    return { released: true };
  });

  const runAction = async (request: FastifyRequest): Promise<unknown> => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { name, id, action } = request.params as { name: string; id: string; action: string };
    requireWorkflow(name);
    return dataAccess.transition(name, id, action, { pool, registry, subject, locale }, payloadOf(request.body));
  };

  app.post(`${prefix}/objects/:name/:id/workflow/:action`, runAction);
  app.post(`${prefix}/objects/:name/:id/transitions/:action`, runAction);
}
