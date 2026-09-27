import { describe, it, expect } from '../helpers/test.js';
import { createPool, inspectSchema, migrate, ObjectRegistry } from '../../src/core/index.js';
import { createDataAccess } from '../../src/index.js';
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
    const object = 'wk_test_meta_obj';
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
      // built-in identity objects (and their side tables) are engine-managed
      expect(actual.has('weavekit_user')).toBe(true);
      expect(actual.has('weavekit_department')).toBe(true);
      expect(actual.has(recordMetaTableName('weavekit_user'))).toBe(true);

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

  it('data-access writes sparse metadata rows on create/update/delete', async () => {
    const object = 'wk_test_meta_da';
    const table = recordMetaTableName(object);
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);

      const reg = new ObjectRegistry();
      reg.register({
        name: object,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'name', type: 'string' },
        ],
      });
      await migrate(reg, { databaseUrl: url! });
      const dataAccess = createDataAccess();
      const ctx = { pool, registry: reg };
      const key = encodeRecordKey(['A1']);

      await dataAccess.create(object, { id: 'A1', name: 'x' }, ctx);
      let meta = await getRecordMeta(pool, object, key);
      expect(meta?.status).toBe('draft');
      expect(meta?.createdBy).toBe('system');
      expect(meta?.modifiedBy).toBe('system');
      const firstModified = meta?.modifiedTime ?? null;

      await new Promise((resolve) => setTimeout(resolve, 5));
      await dataAccess.update(object, encodeRecordKey(['A1']), { name: 'y' }, ctx);
      meta = await getRecordMeta(pool, object, key);
      expect(meta?.modifiedBy).toBe('system');
      expect((meta?.modifiedTime as Date).getTime()).toBeGreaterThan((firstModified as Date).getTime());

      await dataAccess.delete(object, encodeRecordKey(['A1']), ctx);
      expect(await getRecordMeta(pool, object, key)).toBeNull();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);
      await pool.end();
    }
  });

  it('exposes weave_* virtual fields on demand (never by default)', async () => {
    const object = 'wk_test_meta_virtual';
    const table = recordMetaTableName(object);
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);

      const reg = new ObjectRegistry();
      reg.register({
        name: object,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'name', type: 'string' },
        ],
      });
      await migrate(reg, { databaseUrl: url! });
      const dataAccess = createDataAccess();
      const ctx = { pool, registry: reg };
      const created = await dataAccess.create<Record<string, unknown>>(object, { id: 'A1', name: 'x' }, ctx);
      // create returns weave_id (the external id) so a client can address the new record
      expect(created.weave_id).toBe(encodeRecordKey(['A1']));

      // not requested → absent
      const plain = await dataAccess.find<Record<string, unknown>>(object, {}, ctx);
      expect('weave_status' in plain.rows[0]!).toBe(false);

      // requested → merged from the side table
      const withVirtual = await dataAccess.find<Record<string, unknown>>(
        object,
        { fields: ['id', 'name', 'weave_status', 'weave_created_by', 'weave_modified_time'] },
        ctx,
      );
      expect(withVirtual.rows[0]).toMatchObject({
        id: 'A1',
        name: 'x',
        weave_status: 'draft',
        weave_created_by: 'system',
      });
      expect(withVirtual.rows[0]!.weave_modified_time).toBeInstanceOf(Date);

      // weave_id is the record_key (external id); derived without the side table
      const withId = await dataAccess.find<Record<string, unknown>>(object, { fields: ['id', 'weave_id'] }, ctx);
      expect(withId.rows[0]).toEqual({ id: 'A1', weave_id: encodeRecordKey(['A1']) });

      // single-record reads include weave_id too
      const one = await dataAccess.findOne<Record<string, unknown>>(object, encodeRecordKey(['A1']), ctx);
      expect(one?.weave_id).toBe(encodeRecordKey(['A1']));

      // only a virtual field requested → the projection is honored (no leaked pk)
      const onlyVirtual = await dataAccess.find<Record<string, unknown>>(object, { fields: ['weave_status'] }, ctx);
      expect(onlyVirtual.rows[0]).toEqual({ weave_status: 'draft' });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);
      await pool.end();
    }
  });

  it('filters and sorts by weave_* virtual fields (SQL JOIN)', async () => {
    const object = 'wk_test_meta_filter';
    const table = recordMetaTableName(object);
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);

      const reg = new ObjectRegistry();
      reg.register({
        name: object,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'name', type: 'string' },
        ],
      });
      await migrate(reg, { databaseUrl: url! });
      const dataAccess = createDataAccess();
      const ctx = { pool, registry: reg };
      await dataAccess.create(object, { id: 'A1', name: 'a' }, ctx);
      await dataAccess.create(object, { id: 'A2', name: 'b' }, ctx);
      await dataAccess.create(object, { id: 'A3', name: 'c' }, ctx);
      await upsertRecordMeta(pool, object, encodeRecordKey(['A1']), { status: 'running' });
      await upsertRecordMeta(pool, object, encodeRecordKey(['A2']), { status: 'effective' });

      // filter by a virtual field
      const running = await dataAccess.find<Record<string, unknown>>(object, { filter: { weave_status: 'running' } }, ctx);
      expect(running.total).toBe(1);
      expect(running.rows[0]!.id).toBe('A1');

      // sparse row → status defaults to 'draft'
      const draft = await dataAccess.find<Record<string, unknown>>(
        object,
        { filter: { weave_status: 'draft' }, fields: ['id', 'weave_status'] },
        ctx,
      );
      expect(draft.total).toBe(1);
      expect(draft.rows[0]).toEqual({ id: 'A3', weave_status: 'draft' });

      // filter by another virtual field
      const byActor = await dataAccess.find<Record<string, unknown>>(object, { filter: { weave_created_by: 'system' } }, ctx);
      expect(byActor.total).toBe(3);

      // sort by a virtual field
      const sorted = await dataAccess.find<Record<string, unknown>>(
        object,
        { sort: [{ field: 'weave_status', dir: 'asc' }], fields: ['id', 'weave_status'] },
        ctx,
      );
      expect(sorted.rows.map((r) => r.weave_status)).toEqual(['draft', 'effective', 'running']);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "${object}" CASCADE`);
      await pool.end();
    }
  });
});
