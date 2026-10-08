import { describe, it, expect } from '../helpers/test.js';
import { createPool, migrate, ObjectRegistry, SchemaError } from '../../src/core/index.js';
import { createDataAccess } from '../../src/index.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import { recordMetaTableName } from '../../src/core/storage/record-meta.js';
import { getRecordMeta } from '../../src/runtime/record-meta/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Composite primary key E2E (local PG)', () => {
  it('CRUD identity uses the record_key encoding for a composite key', async () => {
    const object = 'wk_composite';
    const table = recordMetaTableName(object);
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);

      const reg = new ObjectRegistry();
      reg.register({
        name: object,
        fields: [
          { name: 'a', type: 'string', primary: true },
          { name: 'b', type: 'integer', primary: true },
          { name: 'name', type: 'string' },
        ],
      });
      await migrate(reg, { databaseUrl: url! });

      // live table carries a real composite primary key
      const pk = await pool.query(
        `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = '"${object}"'::regclass AND i.indisprimary
          ORDER BY array_position(i.indkey, a.attnum)`,
      );
      expect(pk.rows.map((r) => r.attname)).toEqual(['a', 'b']);

      const dataAccess = createDataAccess();
      const ctx = { pool, registry: reg, principal: { kind: 'system' as const, capability: 'internal.admin' as const } };
      const key = encodeRecordKey(['x', '2']);

      await dataAccess.create(object, { a: 'x', b: 2, name: 'n' }, ctx);
      const found = await dataAccess.findOne<{ a: string; b: number; name: string }>(object, key, ctx);
      expect(found).toMatchObject({ a: 'x', b: 2, name: 'n' });

      await dataAccess.update(object, key, { name: 'm' }, ctx);
      expect((await dataAccess.findOne<{ name: string }>(object, key, ctx))?.name).toBe('m');

      // primary keys are immutable — changing one is rejected
      let mutable: unknown;
      try {
        await dataAccess.update(object, key, { a: 'y' }, ctx);
      } catch (e) {
        mutable = e;
      }
      expect(mutable).toBeInstanceOf(SchemaError);
      expect((mutable as SchemaError).code).toBe('object.primary.mutable');

      // side-table row is keyed by the same record_key
      expect((await getRecordMeta(pool, object, key))?.status).toBe('draft');

      // a malformed / wrong-arity key is not found
      let caught: unknown;
      try {
        await dataAccess.findOne(object, encodeRecordKey(['x']), ctx);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SchemaError);

      await dataAccess.delete(object, key, ctx);
      expect(await dataAccess.findOne(object, key, ctx)).toBeNull();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);
      await pool.end();
    }
  });
});
