import { describe, it, expect } from '../helpers/test.js';
import { createPool, migrate, ObjectRegistry } from '../../src/core/index.js';
import { buildEngineFromRegistry } from '../../src/index.js';
import { PgIdentityStore } from '../../src/runtime/identity/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('identity auth seam E2E (engine wiring, local PG + fastify inject)', () => {
  it('verifier → directory → subject; unsynced → identity.notSynced; admin REST CRUD', async () => {
    const setup = createPool(url!);
    await setup.query('DROP TABLE IF EXISTS weavekit_user, weavekit_department CASCADE');
    await setup.end();
    await migrate(new ObjectRegistry(), { databaseUrl: url! });

    const storePool = createPool(url!);
    const store = new PgIdentityStore(storePool);
    const alice = (await store.createUser({ name: 'Alice', roles: ['admin'] })).id;

    const engine = await buildEngineFromRegistry(new ObjectRegistry(), {
      databaseUrl: url!,
      // no `auth.source`: authentication is the verifier → directory composition
      identity: {
        required: true,
        verifier: { verify: (h) => (h === 'Bearer good' ? { ref: alice } : h === 'Bearer ghost' ? { ref: 'ghost' } : null) },
      },
      adapters: { rest: { enabled: true, adminRoles: ['admin'] } },
    });
    const { app, authenticator } = engine;
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
    try {
      // valid credential, synced identity → authenticated (directory roles)
      expect((await authenticator.resolve('Bearer good'))?.roles).toEqual(['admin']);

      expect((await app.inject({ method: 'GET', url: '/api/metadata', headers: bearer('good') })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/metadata' })).statusCode).toBe(401);
      const ghost = await app.inject({ method: 'GET', url: '/api/metadata', headers: bearer('ghost') });
      expect(ghost.statusCode).toBe(403);
      expect(ghost.json().error.code).toBe('identity.notSynced');

      // admin REST: list + create + disable
      const listed = await app.inject({ method: 'GET', url: '/api/identity/users', headers: bearer('good') });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().users.map((u: { id: string }) => u.id)).toContain(alice);

      const created = await app.inject({
        method: 'POST',
        url: '/api/identity/users',
        headers: bearer('good'),
        payload: { name: 'Bob', roles: 'sales,ops' },
      });
      expect(created.statusCode).toBe(201);
      const bobId = created.json().id as string;
      expect((await store.findUser(bobId))?.roles).toEqual(['sales', 'ops']);

      const disabled = await app.inject({
        method: 'PATCH',
        url: `/api/identity/users/${bobId}`,
        headers: bearer('good'),
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect((await store.findUser(bobId))?.enabled).toBe(false);
    } finally {
      await engine.close();
      await storePool.query('DROP TABLE IF EXISTS weavekit_user, weavekit_department CASCADE');
      await storePool.end();
    }
  }, 60000);
});
