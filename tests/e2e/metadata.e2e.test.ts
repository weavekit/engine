import { describe, it, expect } from '../helpers/test.js';
import {
  buildEngineFromRegistry,
  createPool,
  DATA_ACTIONS,
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
    { name: 'name', type: 'string', required: true },
    { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['name'], delete: true, fields: { exclude: ['secret'] } },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

maybe('M11 frontend metadata contract E2E (metadata / permissions / audit, local PG + fastify inject)', () => {
  it('metadata + permissions: auth / RBAC filtering / excluded stripping / ETag 304', async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: {
        source: {
          'key-sales': { id: 'u100', roles: ['sales'] },
          'key-ghost': { id: 'u500', roles: ['ghost_role'] },
        },
      },
    });
    const { app, pool, dataAccess, registry } = engine;
    const base = { pool, registry };
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_meta CASCADE');
      await migrate(registry0, { databaseUrl: url! });
      await dataAccess.create('lead', { id: 'L1', name: 'Acme', status: 'open', owner_id: 'u100', secret: 's1' }, base);

      // ── /api/metadata auth ──
      const noKey = await app.inject({ method: 'GET', url: '/api/metadata' });
      expect(noKey.statusCode).toBe(401);

      // unlisted role → no readable objects
      const ghost = await app.inject({ method: 'GET', url: '/api/metadata', headers: bearer('key-ghost') });
      expect(ghost.statusCode).toBe(200);
      expect(ghost.json().objects).toEqual([]);

      // sales → object list (with field schema + permissions, excluded stripped)
      const sales = await app.inject({ method: 'GET', url: '/api/metadata', headers: bearer('key-sales') });
      expect(sales.statusCode).toBe(200);
      const body = sales.json();
      expect(body.objects.map((o: { name: string }) => o.name)).toEqual(['lead']);
      const lead = body.objects[0];
      expect(lead.fields.map((f: { name: string }) => f.name)).not.toContain('secret');
      expect(lead.permissions).toEqual({ read: 'own', create: true, update: ['name'], delete: true, excludedFields: ['secret'] });

      // single object query + ETag/If-None-Match → 304
      const single = await app.inject({ method: 'GET', url: '/api/metadata?object=lead', headers: bearer('key-sales') });
      expect(single.statusCode).toBe(200);
      expect(single.headers.etag).toBeDefined();
      const notModified = await app.inject({
        method: 'GET',
        url: '/api/metadata?object=lead',
        headers: { ...bearer('key-sales'), 'if-none-match': single.headers.etag! },
      });
      expect(notModified.statusCode).toBe(304);

      // unknown object → 404; unreadable object → 403
      const unknown = await app.inject({ method: 'GET', url: '/api/metadata?object=nope', headers: bearer('key-sales') });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('data.objectUnknown');

      // ── /api/permissions ──
      const permsNoKey = await app.inject({ method: 'GET', url: '/api/permissions' });
      expect(permsNoKey.statusCode).toBe(401);

      const permsGhost = await app.inject({ method: 'GET', url: '/api/permissions', headers: bearer('key-ghost') });
      expect(permsGhost.json().objects).toEqual([]);

      const permsSales = await app.inject({ method: 'GET', url: '/api/permissions', headers: bearer('key-sales') });
      expect(permsSales.statusCode).toBe(200);
      expect(permsSales.json().objects[0]).toEqual({
        name: 'lead',
        label: 'lead',
        permissions: { read: 'own', create: true, update: ['name'], delete: true, excludedFields: ['secret'], createFields: null },
      });
    } finally {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_meta CASCADE');
      await engine.close();
    }
  }, 30000);

  it('audit: own identity visible by default / admin role full / denial 403 / pagination filtering / audit disabled no route', async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();

    // clean up first (before building engine — audit engine creates weavekit_audit table at startup)
    const cleanupPool = createPool(url!);
    await cleanupPool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
    await cleanupPool.end();

    // audit disabled → /api/audit not registered → 404
    const engineNoAudit = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: { source: { 'key-sales': { id: 'u100', roles: ['sales'] } } },
    });
    const noAudit = await engineNoAudit.app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { authorization: 'Bearer key-sales' },
    });
    expect(noAudit.statusCode).toBe(404);
    await engineNoAudit.close();

    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: {
        source: {
          'key-sales': { id: 'u100', roles: ['sales'] },
          'key-admin': { id: 'u900', roles: ['admin'] },
          'key-ghost': { id: 'u500', roles: ['ghost_role'] },
        },
      },
      subsystems: { audit: { enabled: true, batch: { batchSize: 50, flushMs: 50 } } },
      adapters: { rest: { adminRoles: ['admin'] } },
    });
    const { app, pool, dataAccess, registry } = engine;
    const base = { pool, registry };
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

    try {
      await migrate(registry0, { databaseUrl: url! });

      // seed audit events: u100 create ×2 + system create ×1
      await dataAccess.create('lead', { id: 'A1', name: 'a', status: 'open', owner_id: 'u100' }, { ...base, subject: { id: 'u100', roles: ['sales'] } });
      await dataAccess.create('lead', { id: 'A2', name: 'b', status: 'open', owner_id: 'u100' }, { ...base, subject: { id: 'u100', roles: ['sales'] } });
      await dataAccess.create('lead', { id: 'A3', name: 'c', status: 'open', owner_id: 'u100' }, base); // system
      await sleep(250); // wait for L1 buffered sink flush

      // normal identity: by default sees only self (actorId = subject.id)
      const own = await app.inject({ method: 'GET', url: '/api/audit', headers: bearer('key-sales') });
      expect(own.statusCode).toBe(200);
      const ownBody = own.json();
      expect(ownBody.rows.length).toBe(2);
      expect(ownBody.total).toBe(2);
      expect(ownBody.rows.every((r: { actorId: string }) => r.actorId === 'u100')).toBe(true);
      expect(ownBody.rows.every((r: { action: string }) => r.action === DATA_ACTIONS.CREATE)).toBe(true);

      // normal identity querying another → 403 audit.denied.actor
      const cross = await app.inject({ method: 'GET', url: '/api/audit?actorId=u900', headers: bearer('key-sales') });
      expect(cross.statusCode).toBe(403);
      expect(cross.json().error.code).toBe('audit.denied.actor');

      // admin role: omit actorId → full (including system)
      const adminAll = await app.inject({ method: 'GET', url: '/api/audit', headers: bearer('key-admin') });
      expect(adminAll.statusCode).toBe(200);
      expect(adminAll.json().total).toBe(3);

      // admin role filtered by actorId
      const adminFiltered = await app.inject({ method: 'GET', url: '/api/audit?actorId=u100', headers: bearer('key-admin') });
      expect(adminFiltered.json().total).toBe(2);

      // pagination + object filtering
      const paged = await app.inject({ method: 'GET', url: '/api/audit?limit=1&object=lead', headers: bearer('key-admin') });
      expect(paged.json().rows.length).toBe(1);
      expect(paged.json().total).toBe(3);
      expect(paged.json().limit).toBe(1);

      // invalid limit → 400 http.param.invalid
      const badLimit = await app.inject({ method: 'GET', url: '/api/audit?limit=abc', headers: bearer('key-admin') });
      expect(badLimit.statusCode).toBe(400);
      expect(badLimit.json().error.code).toBe('http.param.invalid');

      // auth: no key → 401
      const noKey = await app.inject({ method: 'GET', url: '/api/audit' });
      expect(noKey.statusCode).toBe(401);
    } finally {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      await engine.close();
    }
  }, 30000);
});
