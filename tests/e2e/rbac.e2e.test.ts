import { describe, it, expect } from '../helpers/test.js';import {
  createDataAccess,
  createPool,
  migrate,
  ObjectRegistry,
  READ_SCOPES,
  ROW_SCOPE_MARKERS,
  withRbac,
  SchemaError,
  type RbacSubject,
} from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('RBAC E2E (local PG): row-level/field-level/operation-level enforcement', () => {
  it('own/team/all + exclude + operation denial full path', async () => {
    const registry = new ObjectRegistry();
    registry.register({
      name: 'lead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string' },
        { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
        { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
        { name: 'team_id', type: 'string', [ROW_SCOPE_MARKERS.TEAM]: true },
        { name: 'secret', type: 'string' },
      ],
      permissions: {
        sales: { read: READ_SCOPES.OWN, create: true, update: ['name', 'status'], delete: true, fields: { exclude: ['secret'] } },
        sales_manager: { read: READ_SCOPES.TEAM, update: [], delete: false },
        finance: { read: READ_SCOPES.ALL, fields: { exclude: ['secret'] } },
      },
    });

    const dataAccess = createDataAccess();
    const rbac = withRbac(dataAccess);
    const pool = createPool(url!, { query_timeout: 5000, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_meta CASCADE');
      await migrate(registry, { databaseUrl: url! });
      const base = { pool, registry };

      // seed (permission-less direct connection, freely set ownership)
      await dataAccess.create('lead', { id: 'L1', name: 'Acme', status: 'open', owner_id: 'u100', team_id: 't1', secret: 's1' }, base);
      await dataAccess.create('lead', { id: 'L2', name: 'Globex', status: 'open', owner_id: 'u200', team_id: 't1', secret: 's2' }, base);
      await dataAccess.create('lead', { id: 'L3', name: 'Initech', status: 'won', owner_id: 'u100', team_id: 't2', secret: 's3' }, base);

      const alice = { ...base, subject: { id: 'u100', roles: ['sales'] } as RbacSubject };
      const sarah = { ...base, subject: { id: 'u300', roles: ['sales_manager'], teamId: 't1' } as RbacSubject };
      const emma = { ...base, subject: { id: 'u400', roles: ['finance'] } as RbacSubject };
      const ghost = { ...base, subject: { id: 'u500', roles: ['ghost_role'] } as RbacSubject };

      // own row filtering + field stripping
      const aliceLeads = await rbac.find('lead', {}, alice);
      expect(aliceLeads.total).toBe(2);
      expect(aliceLeads.rows.every((r) => r.owner_id === 'u100')).toBe(true);
      expect(aliceLeads.rows.every((r) => !('secret' in r))).toBe(true);
      expect(aliceLeads.rows.map((r) => r.id).sort()).toEqual(['L1', 'L3']);

      // filter + rowScope combination
      const aliceOpen = await rbac.find('lead', { filter: { status: 'open' } }, alice);
      expect(aliceOpen.rows.map((r) => r.id)).toEqual(['L1']);

      // findOne denied = null (does not leak existence)
      expect(await rbac.findOne('lead', 'L2', alice)).toBeNull();

      // team row filtering
      const sarahLeads = await rbac.find('lead', {}, sarah);
      expect(sarahLeads.rows.map((r) => r.id).sort()).toEqual(['L1', 'L2']);

      // all + exclude
      const emmaLeads = await rbac.find('lead', {}, emma);
      expect(emmaLeads.rows).toHaveLength(3);
      expect(emmaLeads.rows.every((r) => !('secret' in r))).toBe(true);

      // create (own role allowed, returns stripped secret)
      await rbac.create('lead', { id: 'L4', name: 'Umbrella', owner_id: 'u100', team_id: 't1', secret: 's4' }, alice);
      expect((await rbac.find('lead', { filter: { id: 'L4' } }, alice)).rows[0]?.name).toBe('Umbrella');

      // create denied (sales_manager)
      try {
        await rbac.create('lead', { id: 'L5', name: 'x' }, sarah);
        throw new Error('expected create deny');
      } catch (e) {
        expect((e as Error).message).toMatch(/not allowed to create/);
      }

      // update: field whitelist + row scope
      await rbac.update('lead', 'L1', { name: 'Acme2' }, alice);
      expect((await rbac.findOne('lead', 'L1', alice))?.name).toBe('Acme2');
      try {
        await rbac.update('lead', 'L1', { secret: 'x' }, alice);
        throw new Error('expected field deny');
      } catch (e) {
        expect((e as Error).message).toMatch(/field "secret"/);
      }
      try {
        await rbac.update('lead', 'L2', { name: 'x' }, alice);
        throw new Error('expected recordNotFound');
      } catch (e) {
        expect((e as Error).message).toMatch(/not found/);
      }

      // delete: own row deletable, denied row does not leak
      await rbac.delete('lead', 'L3', alice);
      expect((await rbac.find('lead', {}, alice)).total).toBe(2);
      try {
        await rbac.delete('lead', 'L2', alice);
        throw new Error('expected recordNotFound');
      } catch (e) {
        expect((e as Error).message).toMatch(/not found/);
      }

      // read denied (unlisted role)
      try {
        await rbac.find('lead', {}, ghost);
        throw new Error('expected read deny');
      } catch (e) {
        expect((e as Error).message).toMatch(/not allowed to read/);
      }
    } finally {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_meta CASCADE');
      await pool.end();
    }
  }, 30000);

  it('create whitelist + self-created row update still restricted + no read write ops fail-closed', async () => {
    const registry = new ObjectRegistry();
    registry.register({
      name: 'note',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'title', type: 'string', required: true },
        { name: 'status', type: 'enum', options: ['draft', 'done'] },
        { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
        { name: 'secret', type: 'string' },
      ],
      permissions: {
        editor: { read: READ_SCOPES.OWN, create: true, update: ['status'], fields: { create: ['title', 'status', 'owner_id'] } },
        writer: { update: ['status'] },
      },
    });

    const dataAccess = createDataAccess();
    const rbac = withRbac(dataAccess);
    const pool = createPool(url!, { query_timeout: 5000, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
    try {
      await pool.query('DROP TABLE IF EXISTS note, weavekit_meta CASCADE');
      await migrate(registry, { databaseUrl: url! });
      const base = { pool, registry };

      // seed one note owned by the editor (unauthenticated seed)
      await dataAccess.create('note', { id: 'n1', title: 'first', status: 'draft', owner_id: 'u1', secret: 's1' }, base);

      const editor = { ...base, subject: { id: 'u1', roles: ['editor'] } as RbacSubject };

      // create: secret is NOT in the create whitelist → rbac.denied.field
      let deniedField: string | undefined;
      try {
        await rbac.create('note', { id: 'n2', title: 'a', secret: 'x' }, editor);
      } catch (e) {
        deniedField = e instanceof SchemaError ? e.code : undefined;
      }
      expect(deniedField).toBe('rbac.denied.field');

      // create: whitelisted fields (incl. required title) succeed
      await rbac.create('note', { id: 'n3', title: 'ok', status: 'draft', owner_id: 'u1' }, editor);

      // self-created row: status (whitelist) updatable…
      await rbac.update('note', 'n3', { status: 'done' }, editor);
      expect((await rbac.findOne('note', 'n3', editor))?.status).toBe('done');

      // …but title (not in update whitelist) is still denied — creator gets no field exemption
      let titleDenied = false;
      try {
        await rbac.update('note', 'n3', { title: 'renamed' }, editor);
      } catch (e) {
        titleDenied = e instanceof SchemaError && e.code === 'rbac.denied.field';
      }
      expect(titleDenied).toBe(true);

      // writer declares update but no read → fail-closed (no row scope to derive)
      const writer = { ...base, subject: { id: 'w1', roles: ['writer'] } as RbacSubject };
      let updateDenied = false;
      try {
        await rbac.update('note', 'n1', { status: 'done' }, writer);
      } catch (e) {
        updateDenied = e instanceof SchemaError && e.code === 'rbac.denied.update';
      }
      expect(updateDenied).toBe(true);
    } finally {
      await pool.query('DROP TABLE IF EXISTS note, weavekit_meta CASCADE');
      await pool.end();
    }
  }, 30000);
});
