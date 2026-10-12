import { describe, it, expect } from '../helpers/test.js';
import { createDataAccess, createPool, migrate, ObjectRegistry } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

/** `find` total modes: exact (default) / estimate (reltuples) / none (omit) + config default */
maybe('find total modes (local PG)', () => {
  it('exact / estimate / none and instance default', async () => {
    const registry = new ObjectRegistry();
    registry.register({
      name: 'widget',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'kind', type: 'string' },
      ],
    });
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS "widget", weavekit_meta, weavekit_seq, weavekit_record__widget CASCADE');
      await migrate(registry, { databaseUrl: url });
      const ctx = { pool, registry, principal: { kind: 'system' as const, capability: 'internal.admin' as const } };
      const da = createDataAccess();
      for (let i = 0; i < 5; i += 1) {
        await da.create('widget', { id: `w${i}`, kind: i % 2 === 0 ? 'a' : 'b' }, ctx);
      }

      // exact (default): COUNT(*) honours the filter
      const exact = await da.find('widget', { filter: { kind: 'a' } }, ctx);
      expect(exact.total).toBe(3);
      expect(exact.hasMore).toBe(false);

      // none: total omitted; hasMore derived by fetching one extra row
      const none = await da.find('widget', { limit: 2, total: 'none' }, ctx);
      expect(none.rows).toHaveLength(2);
      expect(none.total).toBeUndefined();
      expect(none.hasMore).toBe(true);
      const noneAll = await da.find('widget', { limit: 10, total: 'none' }, ctx);
      expect(noneAll.rows).toHaveLength(5);
      expect(noneAll.hasMore).toBe(false);
      expect(noneAll.total).toBeUndefined();

      // estimate: pg_class.reltuples (ANALYZE first for a deterministic value)
      await pool.query('ANALYZE "widget"');
      const estimate = await da.find('widget', { total: 'estimate' }, ctx);
      expect(estimate.total).toBe(5);

      // instance default (config `query.total`) applies unless overridden per call
      const daEstimate = createDataAccess({ total: 'estimate' });
      await pool.query('ANALYZE "widget"');
      expect((await daEstimate.find('widget', {}, ctx)).total).toBe(5);
      expect((await daEstimate.find('widget', { total: 'exact', filter: { kind: 'b' } }, ctx)).total).toBe(2);
    } finally {
      await pool.query('DROP TABLE IF EXISTS "widget", weavekit_meta, weavekit_seq, weavekit_record__widget CASCADE');
      await pool.end();
    }
  }, 60000);
});
