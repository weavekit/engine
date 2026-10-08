import { describe, it, expect } from '../helpers/test.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import { createDataAccess, createPool, migrate, ObjectRegistry } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LINK_POST = 'weavekit_m2m__post__tag_ids';
const LINK_BUNDLE = 'weavekit_m2m__bundle__pair_ids';

maybe('multiRelation link tables E2E (local PG)', () => {
  it('create/read/update/delete + contains/in/eq/ne + composite FK cascade', async () => {
    const registry = new ObjectRegistry();
    registry.register({ name: 'tag', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'label', type: 'string' }] });
    registry.register({
      name: 'post',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'title', type: 'string' },
        { name: 'tag_ids', type: 'multiRelation', target: 'tag' },
      ],
    });
    // composite primary key target → composite FK
    registry.register({
      name: 'pair',
      fields: [
        { name: 'a', type: 'string', primary: true },
        { name: 'b', type: 'string', primary: true },
        { name: 'label', type: 'string' },
      ],
    });
    registry.register({
      name: 'bundle',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'pair_ids', type: 'multiRelation', target: 'pair' },
      ],
    });
    registry.buildGraph();

    const dataAccess = createDataAccess();
    const pool = createPool(url!, { query_timeout: 5000, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
    try {
      await pool.query(`DROP TABLE IF EXISTS "post", "tag", "bundle", "pair", ${LINK_POST}, ${LINK_BUNDLE} CASCADE`);
      await migrate(registry, { databaseUrl: url });
      const ctx = { pool, registry, principal: { kind: 'system' as const, capability: 'internal.admin' as const } };

      for (const id of ['a', 'b', 'c']) await dataAccess.create('tag', { id, label: id }, ctx);

      // create → read back the ordered array
      const post = await dataAccess.create('post', { id: 'p1', title: 't', tag_ids: ['a', 'b'] }, ctx);
      expect(post.tag_ids).toEqual(['a', 'b']);
      const read = await dataAccess.findOne<{ tag_ids: string[] }>('post', encodeRecordKey(['p1']), ctx);
      expect(read?.tag_ids).toEqual(['a', 'b']);

      // filters: contains (superset) / in (intersection) / eq (set) / ne
      const count = async (filter: unknown) => (await dataAccess.find('post', { filter: filter as never }, ctx)).total;
      expect(await count({ tag_ids: { contains: ['a'] } })).toBe(1);
      expect(await count({ tag_ids: { contains: ['a', 'z'] } })).toBe(0);
      expect(await count({ tag_ids: { in: ['b', 'z'] } })).toBe(1);
      expect(await count({ tag_ids: { in: ['z'] } })).toBe(0);
      expect(await count({ tag_ids: { eq: ['a', 'b'] } })).toBe(1);
      expect(await count({ tag_ids: { eq: ['a'] } })).toBe(0);
      expect(await count({ tag_ids: { ne: ['a'] } })).toBe(1);

      // update replaces the set (order preserved)
      const updated = await dataAccess.update<{ tag_ids: string[] }>('post', encodeRecordKey(['p1']), { tag_ids: ['c', 'b'] }, ctx);
      expect(updated.tag_ids).toEqual(['c', 'b']);

      // target delete cascades the link rows
      await dataAccess.delete('tag', encodeRecordKey(['c']), ctx);
      const afterTarget = await dataAccess.findOne<{ tag_ids: string[] }>('post', encodeRecordKey(['p1']), ctx);
      expect(afterTarget?.tag_ids).toEqual(['b']);

      // composite target: real composite FK + roundtrip
      await dataAccess.create('pair', { a: '1', b: '1', label: 'x' }, ctx);
      await dataAccess.create('pair', { a: '2', b: '2', label: 'y' }, ctx);
      const bundle = await dataAccess.create('bundle', {
        id: 'u1',
        pair_ids: [encodeRecordKey(['1', '1']), encodeRecordKey(['2', '2'])],
      }, ctx);
      expect(bundle.pair_ids).toEqual([encodeRecordKey(['1', '1']), encodeRecordKey(['2', '2'])]);

      // owner delete cascades the link rows
      await dataAccess.delete('post', encodeRecordKey(['p1']), ctx);
      const linkRows = await pool.query(`SELECT count(*)::int AS n FROM ${LINK_POST}`);
      expect(linkRows.rows[0].n).toBe(0);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "post", "tag", "bundle", "pair", ${LINK_POST}, ${LINK_BUNDLE} CASCADE`);
      await pool.end();
    }
  }, 60000);
});
