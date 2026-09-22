import type { FastifyInstance } from 'fastify';
import { listObjectPermissions } from '../../core/object/describe.js';
import type { RestDeps, RestOptions } from './plugin.js';
import { authenticateRequest, checkRateLimit } from './common.js';

/**
 * Permissions route (M11, framework-agnostic): the identity's effective
 * permissions per object — the data source for Refine `accessControlProvider`
 * / frontend RBAC menu & action gating (no more 403 trial-and-error).
 *   GET {prefix}/permissions → { objects: [{ name, labels?, permissions }] }
 * Objects with no resolved permission for the identity are omitted.
 */
export function registerPermissionsRoutes(app: FastifyInstance, deps: RestDeps, options: RestOptions = {}): void {
  const prefix = options.prefix ?? '/api';
  const { registry, authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/permissions`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    return { objects: listObjectPermissions(registry, subject.roles) };
  });
}
