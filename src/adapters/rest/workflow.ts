import type { FastifyInstance } from 'fastify';
import { SchemaError } from '../../core/index.js';
import type { RestDeps, RestOptions } from './plugin.js';
import { authenticateRequest, checkRateLimit } from './common.js';

/**
 * Workflow routes for objects that declare `objects/<name>/workflow.json`:
 *   GET  {prefix}/objects/:name/:id/workflow            → { nodes: [...] }
 *   POST {prefix}/objects/:name/:id/transitions/:action → the updated record
 *
 * Phase C note: the instance/step/workitem runtime (and the state/actions in the
 * GET payload) is rebuilt in C1/C2; the GET currently returns the declared node
 * chain and the POST delegates to the (phase-stubbed) transition executor.
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
    await authenticateRequest(authenticator, request, locale);
    const { name } = request.params as { name: string };
    const def = registry.get(name);
    if (def === undefined) throw new SchemaError('data.objectUnknown', { object: name }, locale);
    if (def.workflow === undefined) throw new SchemaError('http.notFound', {}, locale);
    return { nodes: def.workflow.nodes };
  });

  app.post(`${prefix}/objects/:name/:id/transitions/:action`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { name, id, action } = request.params as { name: string; id: string; action: string };
    return dataAccess.transition(name, id, action, { pool, registry, subject, locale });
  });
}
