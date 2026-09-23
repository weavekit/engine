import type { FastifyInstance } from 'fastify';
import type { Locale, RbacSubject } from '../../core/index.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';
import type { RestOptions } from './plugin.js';

export interface IdentitiesRouteDeps {
  authenticator: Authenticator;
  locale: Locale;
  /** the MCP on-behalf-of identity directory (static `ref → subject`); a function resolver has no introspectable surface */
  identities?: Record<string, RbacSubject>;
}

/**
 * Identity directory route (admin read): surface the engine's
 * `mcp.identities` static directory so the governance console can render an
 * `IdentityTable` (ref → id / roles / team). Only the static-directory form is
 * exposed — a customer-provided `IdentityResolver` (function) has no
 * introspectable entries and returns `{ identities: [] }`.
 *   GET {prefix}/identities → { identities: [{ ref, id, roles, teamId? }] }
 */
export function registerIdentitiesRoutes(
  app: FastifyInstance,
  deps: IdentitiesRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/identities`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'identities', options.adminRoles, locale);
    const identities = Object.entries(deps.identities ?? {}).map(([ref, subjectValue]) => ({
      ref,
      id: subjectValue.id,
      roles: subjectValue.roles,
      ...(subjectValue.teamId === undefined ? {} : { teamId: subjectValue.teamId }),
    }));
    return { identities };
  });
}
