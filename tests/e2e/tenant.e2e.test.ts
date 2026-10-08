import { randomUUID } from 'node:crypto';
import { describe, it, expect } from '../helpers/test.js';
import {
  ObjectRegistry,
  ROW_SCOPE_MARKERS,
  SchemaError,
  createPool,
  encodeRecordKey,
  migrate,
  userPrincipal,
} from '../../src/core/index.js';
import { createDataAccess, executeRestrictedSql, withRbac } from '../../src/runtime/data-access/index.js';
import { createAudit } from '../../src/subsystems/audit/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;
const RLS_ROLE = 'weavekit_query';

/**
 * Tenant isolation against a real PostgreSQL: the app-layer RBAC row scope and
 * the native RLS policy must both confine a subject to its own tenant — with
 * RLS failing closed on a missing tenant GUC. Also covers forced tenant on
 * create, tenant immutability on update, and tenant-scoped audit query.
 */
maybe('tenant isolation E2E (app RBAC + PostgreSQL RLS)', () => {
  it('isolates reads/writes per tenant, forces tenant, blocks moves, RLS fail-closed, audit scoped', async () => {
    const tA = `tA-${randomUUID()}`;
    const tB = `tB-${randomUUID()}`;

    const reg = new ObjectRegistry();
    reg.register({
      name: 'invoice',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'tenant_id', type: 'string', [ROW_SCOPE_MARKERS.TENANT]: true },
        { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
        { name: 'amount', type: 'number' },
      ],
      permissions: {
        admin: { read: 'all', create: true, update: true },
      },
    });
    reg.buildGraph();

    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS invoice CASCADE');
      const migration = await migrate(reg, { databaseUrl: url!, rls: { role: RLS_ROLE } });
      expect(migration.warnings).toEqual([]);

      await pool.query(
        `INSERT INTO invoice (id, tenant_id, owner_id, amount) VALUES
         ('a1',$1,'uA',1),('a2',$1,'uA',2),('b1',$2,'uB',3)`,
        [tA, tB],
      );

      const da = withRbac(createDataAccess({}));
      const ctx = (tenantId: string, id = 'u') => ({
        pool,
        registry: reg,
        principal: userPrincipal({ id, roles: ['admin'], tenantId }),
      });

      // app-layer read isolation applies even with read: 'all'
      const aRows = await da.find('invoice', {}, ctx(tA));
      expect((aRows.rows as { id: string }[]).map((r) => r.id).sort()).toEqual(['a1', 'a2']);
      const bRows = await da.find('invoice', {}, ctx(tB));
      expect((bRows.rows as { id: string }[]).map((r) => r.id)).toEqual(['b1']);

      // create forces the tenant to the subject's tenant (input tB ignored)
      await da.create('invoice', { id: 'a3', tenant_id: tB, owner_id: 'uA', amount: 9 }, ctx(tA));
      const stored = await pool.query('SELECT tenant_id FROM invoice WHERE id = $1', ['a3']);
      expect(stored.rows[0].tenant_id).toBe(tA);

      // tenant is immutable on update
      let immutable: unknown;
      try {
        await da.update('invoice', encodeRecordKey(['a1']), { tenant_id: tB }, ctx(tA));
      } catch (error) {
        immutable = error;
      }
      expect(immutable).toBeInstanceOf(SchemaError);
      expect((immutable as SchemaError).code).toBe('object.tenant.immutable');

      // a cross-tenant write is invisible to the row scope (not found, not updated)
      let notFound: unknown;
      try {
        await da.update('invoice', encodeRecordKey(['b1']), { amount: 99 }, ctx(tA));
      } catch (error) {
        notFound = error;
      }
      expect((notFound as SchemaError).code).toBe('data.recordNotFound');
      const bAmount = await pool.query('SELECT amount FROM invoice WHERE id = $1', ['b1']);
      expect(Number(bAmount.rows[0].amount)).toBe(3);

      // PostgreSQL RLS: same confinement bypassing the app layer (restricted role)
      const viaRls = async (tenantId?: string): Promise<string[]> => {
        const res = await executeRestrictedSql(pool, 'SELECT id FROM invoice', [], {
          rls: {
            role: RLS_ROLE,
            subject: { id: 'x', roles: ['admin'], ...(tenantId === undefined ? {} : { tenantId }) },
          },
        });
        return (res.rows as { id: string }[]).map((r) => r.id).sort();
      };
      expect(await viaRls(tA)).toEqual(['a1', 'a2', 'a3']);
      expect(await viaRls(tB)).toEqual(['b1']);
      // missing tenant GUC → fail-closed (0 rows), never an error or over-exposure
      expect(await viaRls()).toEqual([]);

      // audit query is tenant-scoped
      const audit = await createAudit(pool);
      await audit.record({ actorType: 'system', actorId: 'engine', action: 'test.a', tenantId: tA, timestamp: new Date() });
      await audit.record({ actorType: 'system', actorId: 'engine', action: 'test.b', tenantId: tB, timestamp: new Date() });
      const q = await audit.query({ tenantId: tA });
      expect(q.rows.every((e) => e.tenantId === tA)).toBe(true);
      expect(q.rows.some((e) => e.action === 'test.a')).toBe(true);
      expect(q.rows.some((e) => e.action === 'test.b')).toBe(false);
    } finally {
      await pool.query('DROP TABLE IF EXISTS invoice CASCADE');
      await pool.end();
    }
  }, 60000);
});
