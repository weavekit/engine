import type { FastifyInstance } from 'fastify';
import type { ObjectDefinition } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import type { RestDeps, RestOptions } from './plugin.js';
import { authenticateRequest, checkRateLimit } from './common.js';

interface AvailableAction {
  action: string;
  to: string;
  labels?: Record<string, string>;
}

/** transitions fireable from `state` by an identity carrying one of `roles` */
function availableActions(
  def: ObjectDefinition,
  state: string,
  roles: readonly string[],
): AvailableAction[] {
  const wf = def.workflow;
  if (wf === undefined) return [];
  return wf.transitions
    .filter((t) => t.from === state && (t.roles === undefined || t.roles.some((r) => roles.includes(r))))
    .map((t) => ({
      action: t.action,
      to: t.to,
      ...(t.labels === undefined ? {} : { labels: t.labels }),
    }));
}

/**
 * Workflow routes for objects that declare `objects/<name>/workflow.json`:
 *   GET  {prefix}/objects/:name/:id/workflow            → { state, initial, actions: [...] }
 *   POST {prefix}/objects/:name/:id/transitions/:action → the updated record
 *
 * Both are RBAC-scoped via the data-access layer (transition reuses the update
 * permission and the caller's row scope). Objects without a workflow 404 the
 * GET and reject the POST (`workflow.transition.unknown`).
 */
export function registerWorkflowRoutes(
  app: FastifyInstance,
  deps: RestDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale, registry, dataAccess, pool } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/objects/:name/:id/workflow`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { name, id } = request.params as { name: string; id: string };
    const def = registry.get(name);
    if (def === undefined) throw new SchemaError('data.objectUnknown', { object: name }, locale);
    if (def.workflow === undefined) throw new SchemaError('http.notFound', {}, locale);
    const record = await dataAccess.findOne<Record<string, unknown>>(name, id, {
      pool,
      registry,
      subject,
      locale,
    });
    if (record === null) throw new SchemaError('data.recordNotFound', { object: name, id }, locale);
    const raw = record[def.workflow.stateField];
    const state = typeof raw === 'string' ? raw : String(raw ?? '');
    return { state, initial: def.workflow.initial, actions: availableActions(def, state, subject.roles) };
  });

  app.post(`${prefix}/objects/:name/:id/transitions/:action`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { name, id, action } = request.params as { name: string; id: string; action: string };
    return dataAccess.transition(name, id, action, { pool, registry, subject, locale });
  });
}
