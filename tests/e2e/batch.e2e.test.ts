import { describe, it, expect } from '../helpers/test.js';
import {
  buildEngineFromRegistry,
  migrate,
  ObjectRegistry,
  ROW_SCOPE_MARKERS,
  type ObjectDefinition,
} from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['name', 'status'], delete: true, fields: { exclude: ['secret'] } },
  },
};

maybe('Batch endpoints E2E (PATCH/DELETE /api/objects/:name, withTx atomic, local PG + fastify inject)', () => {
  it('updateMany/deleteMany: successful batch, field denial full rollback, row-level denial full rollback, param validation', async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: { source: { 'key-sales': { id: 'u100', roles: ['sales'] } } },
    });
    const { app, pool, dataAccess, registry } = engine;
    const base = { pool, registry };
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_meta CASCADE');
      await migrate(registry0, { databaseUrl: url! });
      // 3 own rows + 1 other's row (denial candidates)
      for (const [id, owner] of [['L1', 'u100'], ['L2', 'u100'], ['L3', 'u100'], ['LX', 'u200']] as const) {
        await dataAccess.create('lead', { id, name: `n-${id}`, status: 'open', owner_id: owner, secret: 's' }, base);
      }

      // 1. PATCH batch success (whitelisted field status) → { updated: [...] }
      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/objects/lead',
        headers: bearer('key-sales'),
        payload: { ids: ['L1', 'L2'], changes: { status: 'won' } },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().updated).toEqual(['L1', 'L2']);
      const r1 = await dataAccess.findOne('lead', 'L1', base);
      const r2 = await dataAccess.findOne('lead', 'L2', base);
      expect(r1!.status).toBe('won');
      expect(r2!.status).toBe('won');

      // 2. PATCH with denied field (secret not whitelisted) → 403 rbac.denied.field and full rollback (L3 unchanged)
      const deniedField = await app.inject({
        method: 'PATCH',
        url: '/api/objects/lead',
        headers: bearer('key-sales'),
        payload: { ids: ['L1', 'L3'], changes: { secret: 'x' } },
      });
      expect(deniedField.statusCode).toBe(403);
      expect(deniedField.json().error.code).toBe('rbac.denied.field');
      const r3 = await dataAccess.findOne('lead', 'L3', base);
      expect(r3!.status).toBe('open'); // pre-rollback state, confirm L3 unchanged
      const r1again = await dataAccess.findOne('lead', 'L1', base);
      expect(r1again!.status).toBe('won'); // and L1 was in the batch but rolled back (still won from before, not this write)

      // 3. PATCH with row-level denied id (LX owned by another) → 404 recordNotFound and full rollback (L2 stays won)
      const deniedRow = await app.inject({
        method: 'PATCH',
        url: '/api/objects/lead',
        headers: bearer('key-sales'),
        payload: { ids: ['L2', 'LX'], changes: { status: 'lost' } },
      });
      expect(deniedRow.statusCode).toBe(404);
      expect(deniedRow.json().error.code).toBe('data.recordNotFound');
      const r2again = await dataAccess.findOne('lead', 'L2', base);
      expect(r2again!.status).toBe('won'); // whole batch rolled back, L2 not changed to lost

      // 4. DELETE batch success → { deleted: [...] }
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/objects/lead',
        headers: bearer('key-sales'),
        payload: { ids: ['L1', 'L2'] },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().deleted).toEqual(['L1', 'L2']);
      expect(await dataAccess.findOne('lead', 'L1', base)).toBeNull();

      // 5. DELETE with denied id → 404 and full rollback (L3 still exists)
      const delDenied = await app.inject({
        method: 'DELETE',
        url: '/api/objects/lead',
        headers: bearer('key-sales'),
        payload: { ids: ['L3', 'LX'] },
      });
      expect(delDenied.statusCode).toBe(404);
      expect(await dataAccess.findOne('lead', 'L3', base)).not.toBeNull();

      // 6. param validation: empty ids / missing changes → 400
      const noIds = await app.inject({ method: 'PATCH', url: '/api/objects/lead', headers: bearer('key-sales'), payload: { ids: [], changes: {} } });
      expect(noIds.statusCode).toBe(400);
      const noChanges = await app.inject({ method: 'PATCH', url: '/api/objects/lead', headers: bearer('key-sales'), payload: { ids: ['L3'] } });
      expect(noChanges.statusCode).toBe(400);

      // 7. no key → 401
      const noKey = await app.inject({ method: 'PATCH', url: '/api/objects/lead', payload: { ids: ['L3'], changes: {} } });
      expect(noKey.statusCode).toBe(401);
    } finally {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_meta CASCADE');
      await engine.close();
    }
  }, 30000);
});
