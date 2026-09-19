import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { ObjectRegistry, type ObjectDataAccess } from '../../src/index.js';
import { registerObjectRoutes } from '../../src/adapters/rest/plugin.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';
import type { Locale } from '../../src/core/i18n/index.js';

const locale: Locale = 'en';

function buildRegistry(): ObjectRegistry {
  const reg = new ObjectRegistry();
  reg.register({
    name: 'secrets',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'name', type: 'string' },
      { name: 'token', type: 'string', sensitive: true },
    ],
  });
  return reg;
}

const fakeDataAccess: ObjectDataAccess = {
  find: async () => ({
    rows: [{ id: 'r1', name: 'alpha', token: 'tok-1' }, { id: 'r2', name: 'beta', token: 'tok-2' }],
    total: 2,
  }),
  findOne: async (_name: string, id: string) => ({ id, name: 'alpha', token: 'tok-1' }),
  create: async (_name: string, data: Record<string, unknown>) => ({ id: 'new', ...data }),
  update: async (_name: string, id: string, data: Record<string, unknown>) => ({ id, ...data }),
  delete: async () => {},
} as unknown as ObjectDataAccess;

const authenticator: Authenticator = {
  resolve: async () => ({ id: 'u', roles: ['admin'] }),
} as Authenticator;

async function buildApp() {
  const app = Fastify();
  setErrorHandlers(app, locale);
  registerObjectRoutes(
    app,
    { registry: buildRegistry(), pool: {} as never, dataAccess: fakeDataAccess, authenticator, locale },
    { prefix: '/api' },
  );
  await app.ready();
  return app;
}

describe('rest — sensitive fields (masked on read)', () => {
  it('omits sensitive fields from the list response', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/objects/secrets' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows;
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('tok-1');
    expect(rows[0]).toMatchObject({ id: 'r1', name: 'alpha' });
    expect('token' in rows[0]).toBe(false);
    await app.close();
  });

  it('omits sensitive fields from a findOne response', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/objects/secrets/r1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: 'r1', name: 'alpha' });
    expect('token' in body).toBe(false);
    await app.close();
  });

  it('omits sensitive fields from create/update responses', async () => {
    const app = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/objects/secrets', payload: { name: 'x', token: 'tok-new' } });
    expect(created.statusCode).toBe(201);
    expect('token' in created.json()).toBe(false);

    const updated = await app.inject({ method: 'PATCH', url: '/api/objects/secrets/r1', payload: { name: 'y' } });
    expect(updated.statusCode).toBe(200);
    expect('token' in updated.json()).toBe(false);
    await app.close();
  });

  it('writes still store a sensitive value (server-side data-access is unmasked)', async () => {
    const app = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/objects/secrets', payload: { name: 'x', token: 'tok-new' } });
    // the create request body carried token; the returned row omits it — the
    // write path accepts sensitive input (masked only in read responses)
    expect(created.statusCode).toBe(201);
    expect(created.json().name).toBe('x');
    await app.close();
  });
});
