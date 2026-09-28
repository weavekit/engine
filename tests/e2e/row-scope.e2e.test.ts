import { randomUUID } from 'node:crypto';
import { describe, it, expect } from '../helpers/test.js';
import { encodeRecordKey, createPool, migrate, ObjectRegistry, SchemaError } from '../../src/core/index.js';
import { createDataAccess, withRbac } from '../../src/runtime/data-access/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('row scope E2E (local PG): department subtree + external sources + manage split', () => {
  it('department scope includes descendants; owner external ids translate; manage is independent', async () => {
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS widget, note, doc, weavekit_user, weavekit_department CASCADE');

      const reg = new ObjectRegistry();
      reg.register({
        name: 'widget',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'dept_id', type: 'string', department: true },
        ],
        permissions: { viewer: { read: 'department' } },
      });
      reg.register({
        name: 'note',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'owner_ref', type: 'string', ownership: true, ownershipSource: 'external' },
        ],
        permissions: { writer: { read: 'own' } },
      });
      reg.register({
        name: 'doc',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'owner_id', type: 'string', ownership: true },
          { name: 'label', type: 'string' },
        ],
        permissions: { editor: { read: 'all', manage: 'own', update: ['label'] } },
      });
      reg.buildGraph();
      await migrate(reg, { databaseUrl: url! });

      const da = withRbac(createDataAccess());
      const ctx = (subject: { id: string; roles: string[]; departmentId?: string }) => ({ pool, registry: reg, subject });

      // --- department subtree (mode B, internal ids) ---
      const root = randomUUID();
      const child = randomUUID();
      const other = randomUUID();
      await pool.query(
        `INSERT INTO weavekit_department (id, external_source, external_id, name, parent_id) VALUES
         ($1, NULL, NULL, 'Root', NULL), ($2, NULL, NULL, 'Child', $1), ($3, NULL, NULL, 'Other', NULL)`,
        [root, child, other],
      );
      await pool.query(
        `INSERT INTO widget (id, dept_id) VALUES ($1,$2),($3,$4),($5,$6)`,
        ['w-root', root, 'w-child', child, 'w-other', other],
      );
      const atRoot = await da.find('widget', {}, ctx({ id: 'u', roles: ['viewer'], departmentId: root }));
      expect((atRoot.rows as { id: string }[]).map((r) => r.id).sort()).toEqual(['w-child', 'w-root']);
      const atChild = await da.find('widget', {}, ctx({ id: 'u', roles: ['viewer'], departmentId: child }));
      expect((atChild.rows as { id: string }[]).map((r) => r.id)).toEqual(['w-child']);

      // --- own scope with an external ownership column (translated via weavekit_user.external_id) ---
      const internalUser = randomUUID();
      await pool.query(
        `INSERT INTO weavekit_user (id, external_source, external_id, name) VALUES ($1, 'crm', 'ext-a', 'Alice')`,
        [internalUser],
      );
      await pool.query(`INSERT INTO note (id, owner_ref) VALUES ('n-a','ext-a'),('n-b','ext-b')`);
      const mine = await da.find('note', {}, ctx({ id: internalUser, roles: ['writer'] }));
      expect((mine.rows as { id: string }[]).map((r) => r.id)).toEqual(['n-a']);

      // --- manage scope: read 'all' but manage 'own' ---
      await pool.query(`INSERT INTO doc (id, owner_id) VALUES ('d-mine', $1), ('d-other', 'someone-else')`, [internalUser]);
      const editor = ctx({ id: internalUser, roles: ['editor'] });
      // read all
      expect(((await da.find('doc', {}, editor)).rows as { id: string }[]).length).toBe(2);
      // update own → ok
      await da.update('doc', encodeRecordKey(['d-mine']), { label: 'x' }, editor);
      // update another's → row scope hides it (404), despite read: 'all'
      let caught: unknown;
      try {
        await da.update('doc', encodeRecordKey(['d-other']), { label: 'x' }, editor);
      } catch (e) {
        caught = e;
      }
      if (!(caught instanceof SchemaError)) {
        throw new Error(`caught: ${caught instanceof Error ? caught.stack : String(caught)}`);
      }
      expect(caught.code).toBe('data.recordNotFound');
    } finally {
      await pool.query('DROP TABLE IF EXISTS widget, note, doc, weavekit_user, weavekit_department CASCADE');
      await pool.end();
    }
  }, 60000);
});
