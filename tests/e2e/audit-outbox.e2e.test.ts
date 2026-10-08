import { describe, it, expect } from '../helpers/test.js';
import { buildEngineFromRegistry, migrate, ObjectRegistry, ROW_SCOPE_MARKERS, type ObjectDefinition } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
  ],
};

maybe('Audit durable mode E2E (local PG): outbox → relay → weavekit_audit on close', () => {
  it('a write is captured through the transactional outbox and delivered before shutdown', async () => {
    const { Pool } = await import('pg');
    const admin = new Pool({ connectionString: url });
    try {
      await admin.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_metadata, weavekit_audit, weavekit_audit_outbox CASCADE');
    } finally {
      await admin.end();
    }

    const registry = new ObjectRegistry();
    registry.register(LEAD);
    registry.buildGraph();

    const engine = await buildEngineFromRegistry(registry, {
      databaseUrl: url!,
      subsystems: { audit: { enabled: true, mode: 'durable' } },
    });
    try {
      await migrate(registry, { databaseUrl: url! });

      const base = { pool: engine.pool, registry };
      await engine.dataAccess.create('lead', { id: 'L1', name: 'Acme', owner_id: 'u-alice' }, base);

      // close() drains the outbox relay deterministically
      await engine.close();

      const auditPool = new Pool({ connectionString: url });
      try {
        const rows = await auditPool.query(
          `SELECT actor_type, action FROM weavekit_audit WHERE action = 'create' AND object = 'lead'`,
        );
        expect(rows.rows.length).toBeGreaterThan(0);
        const outbox = await auditPool.query(`SELECT count(*)::int AS n FROM weavekit_audit_outbox`);
        expect(outbox.rows[0].n).toBe(0);
      } finally {
        await auditPool.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_metadata, weavekit_audit, weavekit_audit_outbox CASCADE').catch(() => {});
        await auditPool.end();
      }
    } catch (error) {
      try { await engine.close(); } catch { /* already closed */ }
      throw error;
    }
  });
});
