import type { FastifyInstance } from 'fastify';
import type { Locale } from '../../core/index.js';
import type { Capabilities, CapabilitiesProvider } from '../../core/provider/capabilities/index.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit } from './common.js';
import type { RestOptions } from './plugin.js';

export interface CapabilitiesRouteDeps {
  authenticator: Authenticator;
  locale: Locale;
  /**
   * host-injected capability provider (absent = baseline only). The engine
   * surfaces it verbatim and **never judges** licensing.
   */
  capabilities?: CapabilitiesProvider;
}

/**
 * Capabilities route (read-only, authenticated): the console's source of truth
 * for which advanced features to show/hide.
 *   GET {prefix}/capabilities → { features, meta? }
 * The baseline is `{ features: {} }`; a configured provider (e.g. the closed
 * E0 license base) contributes the entitled features.
 */
export function registerCapabilitiesRoutes(
  app: FastifyInstance,
  deps: CapabilitiesRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/capabilities`, async (request) => {
    checkRateLimit(limiter, request, locale);
    await authenticateRequest(authenticator, request, locale);
    const baseline: Capabilities = { features: {} };
    if (deps.capabilities === undefined) return baseline;
    const provided = await deps.capabilities.get();
    return {
      ...baseline,
      ...provided,
      features: { ...baseline.features, ...provided.features },
    };
  });
}
