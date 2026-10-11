import type { FastifyInstance } from 'fastify';
import { SchemaError } from '../../core/index.js';
import type { Locale } from '../../core/index.js';
import type { IdentitySource, IdentityStore } from '../../core/provider/identity/index.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';
import type { RestOptions } from './plugin.js';
import { runIdentitySync } from '../../runtime/identity/index.js';

export interface IdentitySyncRouteDeps {
  authenticator: Authenticator;
  locale: Locale;
  store: IdentityStore;
  /** pre-resolved identity source; absent = no `identity.source` configured (route returns 404) */
  source?: IdentitySource;
  /** default for `deactivateMissing` when the request omits it */
  deactivateMissingDefault?: boolean;
}

/**
 * Identity sync trigger (admin-gated): lets a governance console **manually
 * provision** the configured identity source into the local directory
 * (`weavekit_user`/`weavekit_department`) — the projection step for site
 * members. Read-only against the source; `dryRun` never writes.
 *   POST {prefix}/identity/sync  { dryRun?, deactivateMissing? } → IdentitySyncSummary
 */
export function registerIdentitySyncRoutes(
  app: FastifyInstance,
  deps: IdentitySyncRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.post(`${prefix}/identity/sync`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'identity', options.adminRoles, locale);
    if (deps.source === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const dryRun = body.dryRun === true;
    const deactivateMissing =
      body.deactivateMissing === undefined ? deps.deactivateMissingDefault === true : body.deactivateMissing === true;
    return runIdentitySync(deps.source, deps.store, { dryRun, deactivateMissing });
  });
}
