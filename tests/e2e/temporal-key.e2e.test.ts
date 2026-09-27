import { describe, it, expect } from '../helpers/test.js';
import { createPool, migrate, ObjectRegistry } from '../../src/core/index.js';
import { createDataAccess } from '../../src/index.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import { recordMetaTableName } from '../../src/core/storage/record-meta.js';
import { getRecordMeta, listRecordMeta } from '../../src/runtime/record-meta/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Lossless temporal primary key E2E (local PG)', () => {
  it('preserves microseconds in the record_key (no ms truncation collision)', async () => {
    const object = 'wk_temporal_pk';
    const table = recordMetaTableName(object);
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);

      const reg = new ObjectRegistry();
      reg.register({
        name: object,
        fields: [
          { name: 'at', type: 'timestamptz', primary: true },
          { name: 'name', type: 'string' },
        ],
      });
      await migrate(reg, { databaseUrl: url! });
      const da = createDataAccess();
      const ctx = { pool, registry: reg };

      const a = '2026-09-26T10:30:00.123456Z';
      const b = '2026-09-26T10:30:00.123457Z'; // differs only in microseconds
      await da.create(object, { at: a, name: 'a' }, ctx);
      await da.create(object, { at: b, name: 'b' }, ctx);

      // distinct side-table rows → microseconds were not truncated to milliseconds
      const keyA = encodeRecordKey([a]);
      const keyB = encodeRecordKey([b]);
      expect(keyA).not.toBe(keyB);
      const metas = await listRecordMeta(pool, object, [keyA, keyB]);
      expect(metas).toHaveLength(2);
      expect(await getRecordMeta(pool, object, keyA)).not.toBeNull();
      expect(await getRecordMeta(pool, object, keyB)).not.toBeNull();

      // read back by the external id (the record_key; single PK is length-prefixed too)
      const found = await da.findOne<{ name: string }>(object, encodeRecordKey([a]), ctx);
      expect(found?.name).toBe('a');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);
      await pool.end();
    }
  });
});
