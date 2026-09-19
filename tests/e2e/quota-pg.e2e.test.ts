import { describe, it, expect } from '../helpers/test.js';
import { createPool } from '../../src/index.js';
import { createPgCounterStore } from '../../src/subsystems/quota/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Quota CounterStore PG E2E (local database)', () => {
  it('consume/value limit semantics + period isolation + concurrency does not overspend', async () => {
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS weavekit_counters CASCADE');
      const store = await createPgCounterStore(pool);
      const day = new Date('2026-03-15T00:00:00Z');

      // within budget the increment is applied and reports the new value
      expect(await store.consume('partner', 1, 3, day)).toEqual({ allowed: true, value: 1 });
      expect(await store.consume('partner', 2, 3, day)).toEqual({ allowed: true, value: 3 });

      // at the limit a further consume is denied and leaves the counter untouched
      expect(await store.consume('partner', 1, 3, day)).toEqual({ allowed: false, value: 3 });
      expect(await store.value('partner', day)).toBe(3);

      // a single request larger than the limit is denied from empty
      expect(await store.consume('large', 4, 3, day)).toEqual({ allowed: false, value: 0 });

      // counters are isolated per period
      const nextDay = new Date('2026-03-16T00:00:00Z');
      expect(await store.consume('partner', 1, 3, nextDay)).toEqual({ allowed: true, value: 1 });
      expect(await store.value('partner', day)).toBe(3);

      // concurrency: parallel consumes can never overspend the limit
      const results = await Promise.all(Array.from({ length: 25 }, () => store.consume('burst', 1, 10, day)));
      expect(results.filter((result) => result.allowed)).toHaveLength(10);
      expect(await store.value('burst', day)).toBe(10);
    } finally {
      await pool.query('DROP TABLE IF EXISTS weavekit_counters CASCADE');
      await pool.end();
    }
  }, 30000);

  it('createPgCounterStore idempotent (repeated table creation does not error)', async () => {
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS weavekit_counters CASCADE');
      await createPgCounterStore(pool);
      await createPgCounterStore(pool); // CREATE TABLE IF NOT EXISTS
      const tbl = await pool.query("SELECT to_regclass('weavekit_counters') AS t");
      expect(tbl.rows[0]?.t).not.toBeNull();
    } finally {
      await pool.query('DROP TABLE IF EXISTS weavekit_counters CASCADE');
      await pool.end();
    }
  }, 20000);
});
