import { describe, it, expect } from '../helpers/test.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import {
  ObjectRegistry,
  ROW_SCOPE_MARKERS,
  createPool,
  migrate,
} from '../../src/core/index.js';
import {
  createDataAccess,
  executeRestrictedSql,
  withRbac,
} from '../../src/runtime/data-access/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LINK = 'weavekit_m2m__post__tag_ids';
const RLS_ROLE = 'weavekit_query';

maybe('multiRelation element-level visibility E2E (local PG)', () => {
  it('hides unreadable targets in reads + filters; link table is RLS-denied', async () => {
    const registry = new ObjectRegistry();
    registry.register({
      name: 'tag',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
      ],
      permissions: { reader: { read: 'own' }, admin: { read: 'all' } },
    });
    registry.register({
      name: 'post',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'tag_ids', type: 'multiRelation', target: 'tag' },
      ],
    });
    registry.buildGraph();

    const pool = createPool(url!, { query_timeout: 5000, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
    try {
      await pool.query(`DROP TABLE IF EXISTS "post", "tag", ${LINK} CASCADE`);
      const migration = await migrate(registry, { databaseUrl: url!, rls: { role: RLS_ROLE } });
      expect(migration.warnings).toEqual([]);

      const raw = createDataAccess();
      const noSubject = { pool, registry };
      await raw.create('tag', { id: 't1', owner_id: 'u1' }, noSubject);
      await raw.create('tag', { id: 't2', owner_id: 'u2' }, noSubject);
      await raw.create('post', { id: 'p1', tag_ids: ['t1', 't2'] }, noSubject);

      const rbac = withRbac(createDataAccess({}));
      const read = (subject: { id: string; roles: string[] }) =>
        rbac.findOne<{ tag_ids: string[] | null }>('post', encodeRecordKey(['p1']), {
          pool,
          registry,
          subject,
        });
      const count = async (subject: { id: string; roles: string[] }, filter: unknown) =>
        (await rbac.find('post', { filter: filter as never }, { pool, registry, subject })).total;

      // owner scope: only self-owned target ids are returned
      expect((await read({ id: 'u1', roles: ['reader'] }))?.tag_ids).toEqual(['t1']);
      expect((await read({ id: 'u2', roles: ['reader'] }))?.tag_ids).toEqual(['t2']);
      // read all: the full set
      expect((await read({ id: 'a1', roles: ['admin'] }))?.tag_ids?.sort()).toEqual(['t1', 't2']);
      // no read permission on the target: no element leak (NULL)
      expect((await read({ id: 'n1', roles: ['nobody'] }))?.tag_ids).toBeNull();

      // filters are scoped too — a hidden target is not inferable
      expect(await count({ id: 'u1', roles: ['reader'] }, { tag_ids: { contains: ['t1'] } })).toBe(1);
      expect(await count({ id: 'u1', roles: ['reader'] }, { tag_ids: { contains: ['t2'] } })).toBe(0);
      expect(await count({ id: 'u1', roles: ['reader'] }, { tag_ids: { in: ['t2'] } })).toBe(0);
      expect(await count({ id: 'n1', roles: ['nobody'] }, { tag_ids: { contains: ['t1'] } })).toBe(0);
      expect(await count({ id: 'a1', roles: ['admin'] }, { tag_ids: { contains: ['t2'] } })).toBe(1);

      // link table: RLS enabled with no policy → 0 rows even when granted
      const rlsOn = await pool.query('SELECT relrowsecurity FROM pg_class WHERE relname = $1', [LINK]);
      expect(rlsOn.rows[0].relrowsecurity).toBe(true);
      await pool.query(`GRANT SELECT ON "${LINK}" TO ${RLS_ROLE}`);
      const viaRole = await executeRestrictedSql(pool, `SELECT * FROM "${LINK}"`, [], {
        rls: { role: RLS_ROLE, subject: { id: 'u1', roles: ['reader'] } },
      });
      expect(viaRole.rows.length).toBe(0);

      // idempotent: a second migrate emits no RLS statements
      const again = await migrate(registry, { databaseUrl: url!, rls: { role: RLS_ROLE } });
      expect(again.statements).toEqual([]);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "post", "tag", ${LINK} CASCADE`);
      await pool.end();
    }
  }, 60000);
});
