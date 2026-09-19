import { describe, it, expect } from '../helpers/test.js';import { AUDIT_ACTOR_TYPES, createAudit, DATA_ACTIONS } from '../../src/subsystems/audit/index.js';
import { ObjectRegistry, ROW_SCOPE_MARKERS, SchemaError, buildEngineFromRegistry, createDataAccess, createPool, migrate, withRbac } from '../../src/index.js';
import type { ObjectDefinition } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string', required: true },
    { name: 'name', type: 'string' },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['name'], delete: true, fields: { exclude: ['secret'] } },
  },
};

maybe('Audit subsystem E2E (local PG)', () => {
  it('createAudit idempotent + data-access auto-audit (success/denied/validation failure/system)', async () => {
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      const registry = new ObjectRegistry();
      registry.register(LEAD);
      registry.buildGraph();
      await migrate(registry, { databaseUrl: url! });

      await createAudit(pool); // create table
      const audit = await createAudit(pool); // idempotent

      const dataAccess = withRbac(createDataAccess({ audit }), { audit });
      const base = { pool, registry };
      const subject = { id: 'u100', roles: ['sales'] };
      const sctx = { ...base, subject };

      await dataAccess.create('lead', { id: 'L1', title: 't', name: 'n', owner_id: 'u100', secret: 's' }, sctx);
      await dataAccess.update('lead', 'L1', { name: 'n2' }, sctx);
      await dataAccess.create('lead', { id: 'L2', title: 't2', name: 'n', owner_id: 'u100' }, sctx);
      await dataAccess.delete('lead', 'L2', sctx);

      // denied field → rbac.denied.field (isError audit)
      let deniedCode: string | undefined;
      try {
        await dataAccess.update('lead', 'L1', { secret: 'x' }, sctx);
      } catch (error) {
        deniedCode = error instanceof SchemaError ? error.code : undefined;
      }
      expect(deniedCode).toBe('rbac.denied.field');

      // validation failure (missing required) → isError audit
      let validateCode: string | undefined;
      try {
        await dataAccess.create('lead', { id: 'L3' }, sctx);
      } catch (error) {
        validateCode = error instanceof SchemaError ? error.code : undefined;
      }
      expect(validateCode).toBe('data.field.required');

      // no subject → actorType system
      await dataAccess.create('lead', { id: 'L4', title: 't4', name: 'n', owner_id: 'sys' }, base);

      const res = await audit.query({ object: 'lead' });
      const rows = res.rows;
      const actionOf = (action: string, id?: string): ReturnType<typeof rows.filter> =>
        rows.filter((r) => r.action === action && (id === undefined || r.objectId === id));

      expect(actionOf(DATA_ACTIONS.CREATE, 'L1').length).toBe(1);
      const created = actionOf(DATA_ACTIONS.CREATE, 'L1')[0]!;
      expect(created.isError).toBe(false);
      expect(created.actorType).toBe(AUDIT_ACTOR_TYPES.USER);
      expect(created.actorId).toBe('u100');

      expect(actionOf(DATA_ACTIONS.UPDATE, 'L1').length).toBe(2); // success + denied rejection
      expect(actionOf(DATA_ACTIONS.UPDATE, 'L1').some((r) => r.isError && r.errorCode === 'rbac.denied.field')).toBe(true);

      expect(actionOf(DATA_ACTIONS.DELETE, 'L2').length).toBe(1);

      expect(actionOf(DATA_ACTIONS.CREATE, 'L3')[0]!.isError).toBe(true);
      expect(actionOf(DATA_ACTIONS.CREATE, 'L3')[0]!.errorCode).toBe('data.field.required');

      const sys = actionOf(DATA_ACTIONS.CREATE, 'L4')[0]!;
      expect(sys.actorType).toBe(AUDIT_ACTOR_TYPES.SYSTEM);
      expect(sys.actorId).toBe('system');
    } finally {
      // audit writes are fire-and-forget (`void sink.record`) — they hold pool
      // clients until the INSERT lands. Drain them by closing the pool first
      // (pool.end() waits for in-flight queries), then drop via a fresh
      // connection. Prevents a racing DROP across pool clients (latent flake).
      await pool.end();
      const cleanupPool = createPool(url!);
      await cleanupPool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      await cleanupPool.end();
    }
  }, 60000);

  it('buildEngineFromRegistry integration: subsystems.audit.enabled → write ops auto-audited; close flushes buffer', async () => {
    const pool = createPool(url!);
    let engine;
    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      const registry = new ObjectRegistry();
      registry.register(LEAD);
      registry.buildGraph();
      engine = await buildEngineFromRegistry(registry, {
        databaseUrl: url!,
        auth: { source: { 'k-rep': { id: 'u1', roles: ['sales'] } } },
        subsystems: { audit: { enabled: true } },
      });
      expect(engine.audit).toBeDefined();
      await migrate(engine.registry, { databaseUrl: url! });

      await engine.dataAccess.create(
        'lead',
        { id: 'E1', title: 't', name: 'n', owner_id: 'u1' },
        { pool: engine.pool, registry: engine.registry, subject: { id: 'u1', roles: ['sales'] } },
      );

      // buffered fire-and-forget: stored query may be empty before flush (flushed on close)
      await engine.close();
      engine = undefined;

      const auditPool = createPool(url!);
      try {
        const r = await auditPool.query("SELECT action, actor_id FROM weavekit_audit WHERE object = 'lead'");
        expect(r.rows.some((row: { action: string }) => row.action === DATA_ACTIONS.CREATE)).toBe(true);
        expect(r.rows.every((row: { actor_id: string }) => row.actor_id === 'u1')).toBe(true);
      } finally {
        await auditPool.end();
      }
    } finally {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      await engine?.close();
      await pool.end();
    }
  }, 60000);

  it('audit disabled → no audit table, writes work with zero audit', async () => {
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      const registry = new ObjectRegistry();
      registry.register(LEAD);
      registry.buildGraph();
      const engine = await buildEngineFromRegistry(registry, {
        databaseUrl: url!,
        auth: { source: { 'k-rep': { id: 'u1', roles: ['sales'] } } },
      });
      expect(engine.audit).toBeUndefined();
      await migrate(engine.registry, { databaseUrl: url! });
      await engine.dataAccess.create(
        'lead',
        { id: 'N1', title: 't', name: 'n', owner_id: 'u1' },
        { pool: engine.pool, registry: engine.registry, subject: { id: 'u1', roles: ['sales'] } },
      );
      const tbl = await pool.query("SELECT to_regclass('weavekit_audit') AS t");
      expect(tbl.rows[0]?.t).toBeNull();
      await engine.close();
    } finally {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      await pool.end();
    }
  }, 60000);
});
