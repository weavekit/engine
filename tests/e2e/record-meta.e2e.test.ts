import { describe, it, expect } from '../helpers/test.js';
import { createPool, inspectSchema, migrate, ObjectRegistry } from '../../src/core/index.js';
import { recordMetaTableName } from '../../src/core/storage/record-meta.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import {
  getRecordMeta,
  upsertRecordMeta,
  listRecordMeta,
  deleteRecordMeta,
} from '../../src/runtime/record-meta/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('record metadata side table E2E (local PG)', () => {
  it('creates a sparse side table and round-trips metadata', async () => {
    const object = 'weavekit_test_meta_obj';
    const table = recordMetaTableName(object);
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);

      const reg = new ObjectRegistry();
      reg.register({ name: object, fields: [{ name: 'id', type: 'string', primary: true }] });

      const created = await migrate(reg, { databaseUrl: url! });
      expect(created.statements.some((s) => s.includes(`"${table}"`))).toBe(true);

      const actual = await inspectSchema(pool);
      expect(actual.has(table)).toBe(true);
      expect(actual.has(object)).toBe(true);

      // re-migration is idempotent for both the object and its side table
      const again = await migrate(reg, { databaseUrl: url! });
      expect(again.statements).toEqual([]);

      const key = encodeRecordKey(['O-1']);

      // sparse: a record with no metadata has no row
      expect(await getRecordMeta(pool, object, key)).toBeNull();

      // insert with defaults
      await upsertRecordMeta(pool, object, key, {});
      let row = await getRecordMeta(pool, object, key);
      expect(row?.status).toBe('draft');
      expect(row?.ownerId).toBeNull();

      // merge owner without clobbering status
      await upsertRecordMeta(pool, object, key, { ownerId: '11111111-1111-1111-1111-111111111111' });
      row = await getRecordMeta(pool, object, key);
      expect(row?.status).toBe('draft');
      expect(row?.ownerId).toBe('11111111-1111-1111-1111-111111111111');

      // set status
      await upsertRecordMeta(pool, object, key, { status: 'running' });
      expect((await getRecordMeta(pool, object, key))?.status).toBe('running');

      // list (missing keys are simply absent)
      const key2 = encodeRecordKey(['O-2']);
      await upsertRecordMeta(pool, object, key2, { status: 'effective' });
      const listed = await listRecordMeta(pool, object, [key, key2, encodeRecordKey(['missing'])]);
      expect(listed.map((r) => r.status).sort()).toEqual(['effective', 'running']);

      // delete
      await deleteRecordMeta(pool, object, key);
      expect(await getRecordMeta(pool, object, key)).toBeNull();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);
      await pool.end();
    }
  });
});
