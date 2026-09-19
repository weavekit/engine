import { describe, it, expect } from '../helpers/test.js';
import { buildEngineFromRegistry, migrate, ObjectRegistry, type ObjectDefinition } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
  ],
};

maybe('M10d E2E (audit diff replay: update before/after, delete before, replay off zero snapshot)', () => {
  it('replay:true records before/after; replay default does not populate', async () => {
    let engine: Awaited<ReturnType<typeof buildEngineFromRegistry>> | undefined;
    const pool = await new (await import('pg')).Pool({ connectionString: url });
    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_audit CASCADE');

      const registry0 = new ObjectRegistry();
      registry0.register(LEAD);
      registry0.buildGraph();
      engine = await buildEngineFromRegistry(registry0, {
        databaseUrl: url!,
        auth: { source: { 'k': { id: 'a', roles: ['agent'] } } },
        subsystems: { audit: { enabled: true, replay: true } },
      });
      const { pool: ep, registry, dataAccess } = engine;
      const base = { pool: ep, registry };

      await migrate(registry, { databaseUrl: url! });
      await dataAccess.create('lead', { id: 'L1', name: 'Acme', status: 'open' }, base);
      await dataAccess.update('lead', 'L1', { name: 'Acme2', status: 'won' }, base);
      await dataAccess.create('lead', { id: 'L2', name: 'Globex', status: 'open' }, base);
      await dataAccess.delete('lead', 'L2', base);

      await engine.close();
      engine = undefined;

      const { rows } = await pool.query(
        `SELECT action, object_id, before, after FROM weavekit_audit WHERE action IN ('create','update','delete') ORDER BY id`,
      );
      const update = rows.find((r: { action: string }) => r.action === 'update');
      const del = rows.find((r: { action: string }) => r.action === 'delete');
      const create = rows.find((r: { action: string }) => r.action === 'create');

      // update: before = old row, after = merged new row
      expect(update!.before).toMatchObject({ id: 'L1', name: 'Acme', status: 'open' });
      expect(update!.after).toMatchObject({ id: 'L1', name: 'Acme2', status: 'won' });
      // delete: before = deleted row
      expect(del!.before).toMatchObject({ id: 'L2', name: 'Globex' });
      // create: no before/after
      expect(create!.before).toBeNull();
      expect(create!.after).toBeNull();

      // ── replay default off: table schema always has columns, but events do not populate them
      const registry1 = new ObjectRegistry();
      registry1.register(LEAD);
      registry1.buildGraph();
      engine = await buildEngineFromRegistry(registry1, {
        databaseUrl: url!,
        auth: { source: { 'k': { id: 'a', roles: ['agent'] } } },
        subsystems: { audit: { enabled: true } },
      });
      const { pool: ep2, registry: reg2, dataAccess: da2 } = engine;
      await da2.update('lead', 'L1', { name: 'NoReplay' }, { pool: ep2, registry: reg2 });
      await engine.close();
      engine = undefined;

      const noReplay = await pool.query(
        `SELECT before, after FROM weavekit_audit WHERE action = 'update' ORDER BY id DESC LIMIT 1`,
      );
      expect(noReplay.rows[0]!.before).toBeNull();
      expect(noReplay.rows[0]!.after).toBeNull();
    } finally {
      if (engine !== undefined) {
        try {
          await engine.close();
        } catch {
          // already closed
        }
      }
      try {
        await pool.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_audit CASCADE');
      } catch {
        // pool already ended
      }
      await pool.end();
    }
  }, 60000);
});
