import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { registerIdentitySyncRoutes } from '../../src/adapters/rest/identitySync.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';
import type { IdentitySource } from '../../src/core/provider/identity/index.js';
import type { Locale } from '../../src/core/i18n/index.js';
import { memoryIdentityStore } from '../helpers/identity-store.js';

const locale: Locale = 'en';

function auth(roles: string[]): Authenticator {
  return { resolve: async () => ({ id: 'u', roles }) } as Authenticator;
}

const source: IdentitySource = {
  name: 'crm',
  pull: async () => ({ users: [{ externalId: 'a', roles: ['member'] }], departments: [] }),
};

async function buildApp(opts: { roles?: string[]; withSource?: boolean } = {}) {
  const store = memoryIdentityStore();
  const app = Fastify();
  setErrorHandlers(app, locale);
  registerIdentitySyncRoutes(
    app,
    {
      authenticator: auth(opts.roles ?? ['admin']),
      locale,
      store,
      ...(opts.withSource === false ? {} : { source }),
    },
    { prefix: '/api', adminRoles: ['admin'] },
  );
  await app.ready();
  return { app, store };
}

describe('rest — identity sync trigger', () => {
  it('provisions the configured source and returns the summary', async () => {
    const { app, store } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/identity/sync', headers: { authorization: 'Bearer k' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'crm', dryRun: false, users: { created: 1, updated: 0, disabled: 0 } });
    expect(store.users.size).toBe(1);
    await app.close();
  });

  it('dry-run reports counts without writing', async () => {
    const { app, store } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/sync',
      headers: { authorization: 'Bearer k' },
      payload: { dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, users: { created: 1 } });
    expect(store.users.size).toBe(0);
    await app.close();
  });

  it('returns 404 when no identity source is configured', async () => {
    const { app } = await buildApp({ withSource: false });
    const res = await app.inject({ method: 'POST', url: '/api/identity/sync', headers: { authorization: 'Bearer k' } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('denies a non-admin subject (403)', async () => {
    const { app } = await buildApp({ roles: ['member'] });
    const res = await app.inject({ method: 'POST', url: '/api/identity/sync', headers: { authorization: 'Bearer k' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
