import { describe, it, expect } from '../helpers/test.js';
import { createPool, migrate, ObjectRegistry, SchemaError } from '../../src/core/index.js';
import { createDataAccess, withRbac } from '../../src/runtime/data-access/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

/**
 * Security E2E (real PG): cross-object formula references are RBAC-scoped, and
 * details children inherit their parent's permission + row scope.
 */
maybe('security E2E: formula RBAC + details inheritance', () => {
  it('denies cross-object formula reads and scopes details children by parent', async () => {
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS deal, "order", line, account CASCADE');

      const reg = new ObjectRegistry();
      reg.register({
        name: 'account',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'owner_id', type: 'string', ownership: true },
          { name: 'name', type: 'string' },
        ],
        permissions: { sales: { read: 'own', manage: 'own' } },
      });
      reg.register({
        name: 'deal',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'account_id', type: 'relation', target: 'account' },
          { name: 'account_name', type: 'string', formula: 'account_id.name' },
        ],
        permissions: { sales: { read: 'all', create: true, update: true, delete: false } },
      });
      reg.register({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'owner_id', type: 'string', ownership: true },
          { name: 'lines', type: 'details', target: 'line' },
        ],
        permissions: { sales: { read: 'own', create: true, manage: 'own' } },
      });
      // details child: no permissions (inherits the parent)
      reg.register({ name: 'line', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'label', type: 'string' }] });
      reg.buildGraph();
      await migrate(reg, { databaseUrl: url! });

      const da = withRbac(createDataAccess());
      const system = { pool, registry: reg, principal: { kind: 'system' as const, capability: 'internal.admin' as const } };
      const asUser = (id: string) => ({ pool, registry: reg, principal: { kind: 'user' as const, subject: { id, roles: ['sales'] } } });

      // seed accounts owned by different users
      await da.create('account', { id: 'A', owner_id: 'u1', name: 'Acme' }, system);
      await da.create('account', { id: 'B', owner_id: 'u2', name: 'Globex' }, system);

      // u1 reads their own account but not u2's → formula resolves only for A
      await da.create('deal', { id: 'D1', account_id: 'A' }, asUser('u1'));
      await da.create('deal', { id: 'D2', account_id: 'B' }, asUser('u1'));
      const deals = await da.find('deal', {}, asUser('u1'));
      const names = new Map((deals.rows as { id: string; account_name: unknown }[]).map((r) => [r.id, r.account_name]));
      expect(names.get('D1')).toBe('Acme');
      expect(names.get('D2')).toBeNull();

      // details: order owned by u1 and by u2, each with one line
      const order1 = (await da.create('order', { id: 'O1', owner_id: 'u1', lines: [{ id: 'L1', label: 'a' }] }, system)) as {
        weave_id?: string;
      };
      const order2 = (await da.create('order', { id: 'O2', owner_id: 'u2', lines: [{ id: 'L2', label: 'b' }] }, system)) as {
        weave_id?: string;
      };
      expect(order1.weave_id).toBeDefined();

      // u1 (own scope on order) sees only their child line
      const lines = await da.find('line', {}, asUser('u1'));
      expect((lines.rows as { id: string }[]).map((r) => r.id)).toEqual(['L1']);

      // attaching a new child to u2's order is denied
      let code: string | undefined;
      try {
        await da.create(
          'line',
          { id: 'L3', label: 'c', parent_id: order2.weave_id, parent_type: 'order', parent_idx: 1 },
          asUser('u1'),
        );
      } catch (error) {
        code = error instanceof SchemaError ? error.code : undefined;
      }
      expect(code).toBe('rbac.denied.create');
    } finally {
      await pool.query('DROP TABLE IF EXISTS deal, "order", line, account CASCADE').catch(() => undefined);
      await pool.end();
    }
  }, 60000);
});
