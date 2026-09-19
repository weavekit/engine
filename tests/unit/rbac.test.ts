import { describe, it, expect, beforeEach } from '../helpers/test.js';import {
  buildRowScope,
  canCreate,
  canUpdateField,
  ObjectRegistry,
  READ_SCOPES,
  ROW_SCOPE_MARKERS,
  assertCanCreate,
  assertCanDelete,
  assertCanUpdate,
  assertCanUpdateField,
  defineObject,
  resolvePermission,
  SchemaError,
  withRbac,
  type ObjectDataAccess,
} from '../../src/index.js';

const lead = defineObject({
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'team_id', type: 'string', [ROW_SCOPE_MARKERS.TEAM]: true },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: READ_SCOPES.OWN, create: true, update: ['name'], delete: false, fields: { exclude: ['secret'] } },
    sales_manager: { read: READ_SCOPES.TEAM, update: [], delete: false },
    finance: { read: READ_SCOPES.ALL, fields: { exclude: ['secret'] } },
  },
});

const openObject = defineObject({
  name: 'open_object',
  fields: [{ name: 'id', type: 'string', primary: true }],
});

describe('resolvePermission — default permission semantics', () => {
  it('no permissions map = open mode (full CRUD)', () => {
    expect(resolvePermission(openObject, ['any_role'])).toEqual({
      read: READ_SCOPES.ALL,
      create: true,
      update: null,
      delete: true,
      exclude: [],
      createFields: null,
    });
  });

  it('declared role: operations not written default to deny', () => {
    expect(resolvePermission(lead, ['sales_manager'])).toEqual({
      read: READ_SCOPES.TEAM,
      create: false,
      update: [],
      delete: false,
      exclude: [],
      createFields: null,
    });
  });

  it('declared role: authorized as declared', () => {
    expect(resolvePermission(lead, ['sales'])).toEqual({
      read: READ_SCOPES.OWN,
      create: true,
      update: ['name'],
      delete: false,
      exclude: ['secret'],
      createFields: null,
    });
  });

  it('update: true → all fields updatable (internally null); update: false → none updatable (internally [])', () => {
    const withTrue = defineObject({
      name: 'u_obj',
      fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }],
      permissions: { role: { read: READ_SCOPES.ALL, update: true } },
    });
    expect(resolvePermission(withTrue, ['role'])!.update).toBeNull();

    const withFalse = defineObject({
      name: 'u_obj2',
      fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }],
      permissions: { role: { read: READ_SCOPES.ALL, update: false } },
    });
    expect(resolvePermission(withFalse, ['role'])!.update).toEqual([]);
  });

  it('map declared but role not listed = no permission (undefined)', () => {
    expect(resolvePermission(lead, ['ghost'])).toBeUndefined();
  });

  it('multi-role merge: read takes most permissive, update/exclude take union', () => {
    expect(resolvePermission(lead, ['sales', 'finance'])).toEqual({
      read: READ_SCOPES.ALL,
      create: true,
      update: ['name'],
      delete: false,
      exclude: ['secret'],
      createFields: null,
    });
  });

  it('fields.create: undeclared = unrestricted (null); declared = whitelist; any unrestricted role means unrestricted', () => {
    const withCreate = defineObject({
      name: 'note',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'title', type: 'string', required: true },
        { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
        { name: 'secret', type: 'string' },
      ],
      permissions: {
        editor: { read: READ_SCOPES.OWN, create: true, update: ['title'], fields: { create: ['title'] } },
        manager: { read: READ_SCOPES.ALL, create: true },
      },
    });
    // declared whitelist
    expect(resolvePermission(withCreate, ['editor'])!.createFields).toEqual(['title']);
    // role without fields.create stays unrestricted
    expect(resolvePermission(withCreate, ['manager'])!.createFields).toBeNull();
    // any unrestricted role → unrestricted
    expect(resolvePermission(withCreate, ['editor', 'manager'])!.createFields).toBeNull();
  });
});

describe('buildRowScope — row-level scope', () => {
  it('all → no filter', () => {
    expect(buildRowScope(lead, READ_SCOPES.ALL, { id: 'u1', roles: ['sales'] }, ['sales'])).toBeUndefined();
  });

  it('own → ownership field = subject.id', () => {
    expect(buildRowScope(lead, READ_SCOPES.OWN, { id: 'u1', roles: ['sales'] }, ['sales'])).toEqual({
      sql: '"owner_id" = $1',
      params: ['u1'],
    });
  });

  it('team → team field = subject.teamId', () => {
    expect(buildRowScope(lead, READ_SCOPES.TEAM, { id: 'm1', roles: ['sales_manager'], teamId: 't1' }, ['sales_manager'])).toEqual({
      sql: '"team_id" = $1',
      params: ['t1'],
    });
  });

  it('team but subject has no teamId → deny', () => {
    expect(() => buildRowScope(lead, READ_SCOPES.TEAM, { id: 'm1', roles: ['sales_manager'] }, ['sales_manager'])).toThrow(
      SchemaError,
    );
  });

  it('own but no ownership field → defensive deny', () => {
    expect(() => buildRowScope(openObject, READ_SCOPES.OWN, { id: 'u1', roles: ['x'] }, ['x'])).toThrow(SchemaError);
  });
});

describe('authorize — operation and field decision matrix', () => {
  it('create', () => {
    expect(canCreate(lead, ['sales'])).toBe(true);
    expect(canCreate(lead, ['sales_manager'])).toBe(false);
    expect(() => assertCanCreate(lead, ['sales_manager'])).toThrow(/not allowed to create/);
  });

  it('update: [] = not updatable; field whitelist', () => {
    expect(() => assertCanUpdate(lead, ['sales_manager'])).toThrow(/not allowed to update/);
    expect(canUpdateField(lead, ['sales'], 'name')).toBe(true);
    expect(canUpdateField(lead, ['sales'], 'owner_id')).toBe(false);
    expect(() => assertCanUpdateField(lead, ['sales'], 'owner_id')).toThrow(/field "owner_id"/);
    expect(() => assertCanUpdate(lead, ['sales'])).not.toThrow();
  });

  it('delete', () => {
    expect(() => assertCanDelete(lead, ['sales'])).toThrow(/not allowed to delete/);
  });

  it('unlisted role denies everything', () => {
    expect(() => assertCanCreate(lead, ['ghost'])).toThrow(/not allowed to create/);
  });
});

describe('withRbac — data access decorator', () => {
  const registry = new ObjectRegistry();
  registry.register(lead);
  registry.register(openObject);

  let calls: unknown[] = [];
  const inner = {
    find: async (object: string, opts: unknown, ctx: unknown) => {
      calls.push(['find', object, opts, ctx]);
      return { rows: [{ id: '1', name: 'a', owner_id: 'u1', secret: 's' }], total: 1 };
    },
    findOne: async (object: string, id: string, ctx: unknown) => {
      calls.push(['findOne', object, id, ctx]);
      return { id: '1', name: 'a', owner_id: 'u1', secret: 's' };
    },
    create: async (object: string, data: Record<string, unknown>, ctx: unknown) => {
      calls.push(['create', object, data, ctx]);
      return { id: '1', ...data };
    },
    update: async (object: string, id: string, changes: Record<string, unknown>, ctx: unknown) => {
      calls.push(['update', object, id, changes, ctx]);
      return { id, ...changes };
    },
    delete: async (object: string, id: string, ctx: unknown) => {
      calls.push(['delete', object, id, ctx]);
      return undefined;
    },
  } as unknown as ObjectDataAccess;
  const rbac = withRbac(inner);

  const baseCtx = (subject?: { id: string; roles: string[]; teamId?: string }) => ({
    pool: {} as never,
    registry,
    subject,
  });

  beforeEach(() => {
    calls = [];
  });

  it('no subject → pass through (no exclude/rowScope injected)', async () => {
    await rbac.find('lead', {}, baseCtx(undefined));
    expect(calls[0]).toEqual(['find', 'lead', {}, expect.objectContaining({ subject: undefined })]);
    expect((calls[0] as unknown[])[2]).not.toHaveProperty('exclude');
  });

  it('find: injects exclude + rowScope', async () => {
    await rbac.find('lead', {}, baseCtx({ id: 'u1', roles: ['sales'] }));
    const [method, object, opts, ctx] = calls[0] as [string, string, { exclude?: string[] }, { rowScope?: { sql: string; params: unknown[] } }];
    expect(method).toBe('find');
    expect(object).toBe('lead');
    expect(opts.exclude).toEqual(['secret']);
    expect(ctx.rowScope).toEqual({ sql: '"owner_id" = $1', params: ['u1'] });
  });

  it('find: read deny (unlisted role)', async () => {
    try {
      await rbac.find('lead', {}, baseCtx({ id: 'u1', roles: ['ghost'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/not allowed to read/);
    }
  });

  it('findOne: returned record strips exclude fields', async () => {
    const record = await rbac.findOne('lead', '1', baseCtx({ id: 'u1', roles: ['sales'] }));
    expect(record).toEqual({ id: '1', name: 'a', owner_id: 'u1' });
  });

  it('create: deny without permission', async () => {
    try {
      await rbac.create('lead', { id: '2' }, baseCtx({ id: 'm1', roles: ['sales_manager'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/not allowed to create/);
    }
  });

  it('update: unauthorized field denied, legitimate field passed through', async () => {
    try {
      await rbac.update('lead', '1', { secret: 'x' }, baseCtx({ id: 'u1', roles: ['sales'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/field "secret"/);
    }
    await rbac.update('lead', '1', { name: 'b' }, baseCtx({ id: 'u1', roles: ['sales'] }));
    const changes = (calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(changes).toEqual({ name: 'b' });
  });

  it('update: update=[] role denied', async () => {
    try {
      await rbac.update('lead', '1', { name: 'b' }, baseCtx({ id: 'm1', roles: ['sales_manager'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/not allowed to update/);
    }
  });

  it('delete: deny without permission', async () => {
    try {
      await rbac.delete('lead', '1', baseCtx({ id: 'u1', roles: ['sales'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/not allowed to delete/);
    }
  });

  it('update injects rowScope (own role can only modify its own rows)', async () => {
    await rbac.update('lead', '1', { name: 'b' }, baseCtx({ id: 'u1', roles: ['sales'] }));
    const ctx = (calls[0] as unknown[])[4] as { rowScope?: { sql: string; params: unknown[] } };
    expect(ctx.rowScope).toEqual({ sql: '"owner_id" = $1', params: ['u1'] });
  });
});

describe('withRbac — create whitelist + write ops without read fail-closed', () => {
  const registry = new ObjectRegistry();
  registry.register(
    defineObject({
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
    }),
  );

  let calls: unknown[] = [];
  const inner = {
    find: async () => ({ rows: [], total: 0 }),
    findOne: async (object: string, id: string, ctx: unknown) => {
      calls.push(['findOne', object, id, ctx]);
      return { id, title: 't', status: 'draft', owner_id: 'u1', secret: 's' };
    },
    create: async (object: string, data: Record<string, unknown>, ctx: unknown) => {
      calls.push(['create', object, data, ctx]);
      return { id: '1', ...data };
    },
    update: async (object: string, id: string, changes: Record<string, unknown>, ctx: unknown) => {
      calls.push(['update', object, id, changes, ctx]);
      return { id, ...changes };
    },
    delete: async (object: string, id: string, ctx: unknown) => {
      calls.push(['delete', object, id, ctx]);
      return undefined;
    },
  } as unknown as ObjectDataAccess;
  const rbac = withRbac(inner);

  const baseCtx = (subject?: { id: string; roles: string[]; teamId?: string }) => ({
    pool: {} as never,
    registry,
    subject,
  });

  beforeEach(() => {
    calls = [];
  });

  it('create: non-whitelisted field denied (fields.create)', async () => {
    try {
      await rbac.create('note', { id: 'n1', title: 'a', secret: 'x' }, baseCtx({ id: 'u1', roles: ['editor'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/field "secret"/);
    }
  });

  it('create: whitelisted fields allowed and passed through (including required fields)', async () => {
    await rbac.create('note', { id: 'n1', title: 'a', status: 'draft', owner_id: 'u1' }, baseCtx({ id: 'u1', roles: ['editor'] }));
    const data = (calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(data).toEqual({ id: 'n1', title: 'a', status: 'draft', owner_id: 'u1' });
  });

  it('update: role without read scope fail-closed (cannot modify arbitrary rows)', async () => {
    try {
      await rbac.update('note', 'n1', { status: 'done' }, baseCtx({ id: 'w1', roles: ['writer'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/not allowed to update/);
    }
  });

  it('delete: role without read scope fail-closed', async () => {
    try {
      await rbac.delete('note', 'n1', baseCtx({ id: 'w1', roles: ['writer'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/not allowed to delete/);
    }
  });

  it('update on self-created row: still bound by update whitelist (creator gets no field exemption)', async () => {
    // editor owns the row; title is NOT in the update whitelist
    try {
      await rbac.update('note', 'n1', { title: 'renamed' }, baseCtx({ id: 'u1', roles: ['editor'] }));
      throw new Error('expected deny');
    } catch (e) {
      expect((e as Error).message).toMatch(/field "title"/);
    }
    // status is in the whitelist → allowed, row-scoped
    await rbac.update('note', 'n1', { status: 'done' }, baseCtx({ id: 'u1', roles: ['editor'] }));
    const ctx = (calls[0] as unknown[])[4] as { rowScope?: { sql: string; params: unknown[] } };
    expect(ctx.rowScope).toEqual({ sql: '"owner_id" = $1', params: ['u1'] });
  });
});
