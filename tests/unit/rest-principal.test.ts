import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { ObjectRegistry, SYSTEM_CAPABILITIES, systemPrincipal, type AccessPrincipal, type ObjectDataAccess } from '../../src/index.js';
import { registerObjectRoutes } from '../../src/adapters/rest/plugin.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';
import type { Locale } from '../../src/core/i18n/index.js';

const locale: Locale = 'en';

function buildRegistry(): ObjectRegistry {
  const reg = new ObjectRegistry();
  reg.register({ name: 'things', fields: [{ name: 'id', type: 'string', primary: true }] });
  return reg;
}

const authenticator: Authenticator = {
  resolve: async () => ({ id: 'u', roles: ['member'] }),
} as Authenticator;

async function buildApp(principalFor?: (req: unknown, subject: unknown) => AccessPrincipal) {
  let seen: AccessPrincipal | undefined;
  const dataAccess = {
    find: async (_name: string, _opts: unknown, ctx: { principal: AccessPrincipal }) => {
      seen = ctx.principal;
      return { rows: [], total: 0 };
    },
  } as unknown as ObjectDataAccess;
  const app = Fastify();
  setErrorHandlers(app, locale);
  registerObjectRoutes(
    app,
    { registry: buildRegistry(), pool: {} as never, dataAccess, authenticator, locale },
    { prefix: '/api', ...(principalFor === undefined ? {} : { principalFor: principalFor as never }) },
  );
  await app.ready();
  return { app, principal: () => seen };
}

describe('rest — injectable principal resolver (D32)', () => {
  it('defaults to the user principal', async () => {
    const { app, principal } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/objects/things' });
    expect(res.statusCode).toBe(200);
    expect(principal()).toMatchObject({ kind: 'user', subject: { id: 'u' } });
    await app.close();
  });

  it('elevates to a system principal when a resolver is injected', async () => {
    const { app, principal } = await buildApp(() => systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN, 'control plane'));
    const res = await app.inject({ method: 'GET', url: '/api/objects/things' });
    expect(res.statusCode).toBe(200);
    expect(principal()).toMatchObject({ kind: 'system', capability: SYSTEM_CAPABILITIES.INTERNAL_ADMIN });
    await app.close();
  });
});
