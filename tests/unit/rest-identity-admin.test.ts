import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { registerIdentityAdminRoutes } from '../../src/adapters/rest/identityAdmin.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import { IdentityAdmin } from '../../src/runtime/identity/index.js';
import { memoryIdentityStore } from '../helpers/identity-store.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';
import type { Locale } from '../../src/core/i18n/index.js';

const locale: Locale = 'en';

function auth(roles: string[]): Authenticator {
  return { resolve: async () => ({ id: 'u', roles }) } as Authenticator;
}

async function buildApp(roles: string[] = ['admin']) {
  const store = memoryIdentityStore();
  const admin = new IdentityAdmin(store);
  const app = Fastify();
  setErrorHandlers(app, locale);
  registerIdentityAdminRoutes(app, { authenticator: auth(roles), locale, admin }, { prefix: '/api', adminRoles: ['admin'] });
  await app.ready();
  return { app, admin };
}

const H = { authorization: 'Bearer k' };

describe('rest — identity admin (users + departments)', () => {
  it('creates a user, sets roles, then deletes it', async () => {
    const { app } = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/identity/users', headers: H, payload: { name: 'Ann', email: 'a@x', roles: 'member' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const patched = await app.inject({ method: 'PATCH', url: `/api/identity/users/${id}`, headers: H, payload: { roles: ['admin', 'sales'] } });
    expect(patched.statusCode).toBe(200);
    const users = (await app.inject({ method: 'GET', url: '/api/identity/users', headers: H })).json().users;
    expect(users.find((u: { id: string }) => u.id === id).roles).toEqual(['admin', 'sales']);

    const del = await app.inject({ method: 'DELETE', url: `/api/identity/users/${id}`, headers: H });
    expect(del.statusCode).toBe(204);
    const after = (await app.inject({ method: 'GET', url: '/api/identity/users', headers: H })).json().users;
    expect(after.some((u: { id: string }) => u.id === id)).toBe(false);
    await app.close();
  });

  it('PATCH toggles enabled; unknown id → 404; empty body → 400', async () => {
    const { app } = await buildApp();
    const id = (await app.inject({ method: 'POST', url: '/api/identity/users', headers: H, payload: { name: 'Bob' } })).json().id as string;
    expect((await app.inject({ method: 'PATCH', url: `/api/identity/users/${id}`, headers: H, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/identity/users/nope', headers: H, payload: { enabled: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/identity/users/${id}`, headers: H, payload: {} })).statusCode).toBe(400);
    await app.close();
  });

  it('creates and lists departments', async () => {
    const { app } = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/identity/departments', headers: H, payload: { name: 'Sales', code: 'S' } });
    expect(created.statusCode).toBe(201);
    const deps = (await app.inject({ method: 'GET', url: '/api/identity/departments', headers: H })).json().departments;
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ name: 'Sales', code: 'S' });
    await app.close();
  });

  it('denies a non-admin subject (403)', async () => {
    const { app } = await buildApp(['member']);
    expect((await app.inject({ method: 'GET', url: '/api/identity/users', headers: H })).statusCode).toBe(403);
    await app.close();
  });
});
