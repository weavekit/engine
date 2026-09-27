import { describe, it, expect } from '../helpers/test.js';
import { createPool, inspectSchema, migrate, ObjectRegistry } from '../../src/core/index.js';
import { createDataAccess } from '../../src/index.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Composite-target relation E2E (local PG)', () => {
  it('references a composite primary key via record_key', async () => {
    const target = 'wk_composite_tgt';
    const ref = 'wk_composite_ref';
    const pool = createPool(url!);
    try {
      await pool.query(
        `DROP TABLE IF EXISTS "${ref}", "${target}", "weavekit_record__${ref}", "weavekit_record__${target}" CASCADE`,
      );

      const reg = new ObjectRegistry();
      reg.register({
        name: target,
        fields: [
          { name: 'a', type: 'string', primary: true },
          { name: 'b', type: 'integer', primary: true },
          { name: 'name', type: 'string' },
        ],
      });
      reg.register({
        name: ref,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'target', type: 'relation', target },
          { name: 'target_name', type: 'string', formula: 'target.name' },
        ],
      });
      await migrate(reg, { databaseUrl: url! });

      const actual = await inspectSchema(pool);
      const refTable = actual.get(ref)!;
      // a composite target is referenced by record_key text — no real FK
      expect(refTable.fks.some((f) => f.column === 'target')).toBe(false);

      const dataAccess = createDataAccess();
      const ctx = { pool, registry: reg };
      await dataAccess.create(target, { a: 'x', b: 2, name: 'Target X' }, ctx);
      const key = encodeRecordKey(['x', '2']);

      // valid record_key resolves (incl. a cross-object formula on the relation)
      const created = await dataAccess.create<{ target_name: string }>(ref, { id: 'R1', target: key }, ctx);
      expect(created.target_name).toBe('Target X');

      // a record_key that matches no target row is rejected
      let caught: unknown;
      try {
        await dataAccess.create(ref, { id: 'R2', target: encodeRecordKey(['x', '9']) }, ctx);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
    } finally {
      await pool.query(
        `DROP TABLE IF EXISTS "${ref}", "${target}", "weavekit_record__${ref}", "weavekit_record__${target}" CASCADE`,
      );
      await pool.end();
    }
  });
});
