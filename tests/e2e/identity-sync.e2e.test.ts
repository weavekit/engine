import { describe, it, expect } from '../helpers/test.js';
import { createPool, migrate, ObjectRegistry } from '../../src/core/index.js';
import {
  PgIdentityDirectory,
  PgIdentityStore,
  createPgIdentitySource,
  runIdentitySync,
} from '../../src/runtime/identity/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const U = 'wk_idsrc_user';
const D = 'wk_idsrc_dept';

maybe('identity sync E2E (real PG): customer directory → weavekit_user/department', () => {
  it('provisions, links, is idempotent, soft-disables, and resolves a subject', async () => {
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS ${U}, ${D} CASCADE`);
      await pool.query('DROP TABLE IF EXISTS weavekit_user, weavekit_department CASCADE');
      await pool.query(`CREATE TABLE ${D} (id text PRIMARY KEY, name text, parent_id text, lead text, active text)`);
      await pool.query(`CREATE TABLE ${U} (id text PRIMARY KEY, full_name text, email text, role text, dept_id text, manager_id text, active text)`);
      await pool.query(
        `INSERT INTO ${D} VALUES ('d1', 'Sales', NULL, 'u1', 't'), ('d2', 'East', 'd1', 'u2', 't')`,
      );
      await pool.query(
        `INSERT INTO ${U} VALUES
           ('u1', 'Alice', 'a@x', 'admin,sales', 'd1', NULL, 't'),
           ('u2', 'Bob', 'b@x', 'sales', 'd2', 'u1', 't')`,
      );
      // engine-owned identity tables
      await migrate(new ObjectRegistry(), { databaseUrl: url! });

      const store = new PgIdentityStore(pool);
      const source = createPgIdentitySource(
        {
          name: 'crm',
          users: { table: U, id: 'id', name: 'full_name', email: 'email', roles: 'role', department: 'dept_id', director: 'manager_id', enabled: 'active' },
          departments: { table: D, id: 'id', name: 'name', parent: 'parent_id', manager: 'lead', enabled: 'active' },
        },
        pool,
      );

      const summary = await runIdentitySync(source, store, { deactivateMissing: true });
      expect(summary.users.created).toBe(2);
      expect(summary.departments.created).toBe(2);

      const u1 = (await store.findUserByExternal('crm', 'u1'))!;
      const u2 = (await store.findUserByExternal('crm', 'u2'))!;
      const d1 = (await store.findDepartmentByExternal('crm', 'd1'))!;
      const d2 = (await store.findDepartmentByExternal('crm', 'd2'))!;
      expect(u1.roles).toEqual(['admin', 'sales']);
      expect(u1.departmentId).toBe(d1.id);
      expect(u2.departmentId).toBe(d2.id);
      expect(u2.directorId).toBe(u1.id);
      expect(d2.parentId).toBe(d1.id);
      expect(d2.managerId).toBe(u2.id);

      // idempotent re-run
      const again = await runIdentitySync(source, store, { deactivateMissing: true });
      expect(again.users).toEqual({ created: 0, updated: 2, disabled: 0 });
      expect(again.departments).toEqual({ created: 0, updated: 2, disabled: 0 });

      // directory resolves the internal subject (external ref → internal id)
      const dir = new PgIdentityDirectory(store);
      const subject = await dir.resolve('u2');
      expect(subject).toEqual({ id: u2.id, roles: ['sales'], departmentId: d2.id });

      // removing u2 from the source soft-disables it (no delete) and resolution fails closed
      await pool.query(`DELETE FROM ${U} WHERE id = 'u2'`);
      const disabled = await runIdentitySync(source, store, { deactivateMissing: true });
      expect(disabled.users.disabled).toBe(1);
      expect((await store.findUserByExternal('crm', 'u2'))?.enabled).toBe(false);
      expect(await dir.resolve('u2')).toBeNull();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${U}, ${D} CASCADE`);
      await pool.end();
    }
  });
});
