import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { registerCapabilitiesRoutes } from '../../src/adapters/rest/capabilities.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';
import type { CapabilitiesProvider } from '../../src/core/provider/capabilities/index.js';
import type { Locale } from '../../src/core/i18n/index.js';

const locale: Locale = 'en';

const authed: Authenticator = {
  resolve: async () => ({ id: 'u', roles: ['member'] }),
} as Authenticator;

const anon: Authenticator = {
  resolve: async () => null,
} as Authenticator;

async function buildApp(capabilities?: CapabilitiesProvider, authenticator: Authenticator = authed) {
  const app = Fastify();
  setErrorHandlers(app, locale);
  registerCapabilitiesRoutes(app, { authenticator, locale, ...(capabilities === undefined ? {} : { capabilities }) }, {
    prefix: '/api',
  });
  await app.ready();
  return app;
}

describe('rest — capabilities (read-only seam)', () => {
  it('returns the baseline when no provider is configured', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/capabilities', headers: { authorization: 'Bearer k' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ features: {} });
    await app.close();
  });

  it('surfaces the host-injected provider (features + meta)', async () => {
    const provider: CapabilitiesProvider = {
      get: () => ({ features: { 'sso.saml': true, 'audit.export': false }, meta: { edition: 'enterprise' } }),
    };
    const app = await buildApp(provider);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities', headers: { authorization: 'Bearer k' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      features: { 'sso.saml': true, 'audit.export': false },
      meta: { edition: 'enterprise' },
    });
    await app.close();
  });

  it('rejects an unauthenticated request (401)', async () => {
    const app = await buildApp(undefined, anon);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
