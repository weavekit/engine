import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, ROW_SCOPE_MARKERS, SchemaError, buildRowScope, buildRlsPolicy, defineObject, encodeRecordKey, userPrincipal } from '../../src/core/index.js';
import { createDataAccess, executeRestrictedSql, withRbac } from '../../src/runtime/data-access/index.js';
import { queryAudit } from '../../src/subsystems/audit/store.js';

const TENANT_DEF = defineObject({
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'tenant_id', type: 'string', [ROW_SCOPE_MARKERS.TENANT]: true },
  ],
  permissions: { sales: { read: 'own' }, admin: { read: 'all', create: true, update: true } },
});

const NO_TENANT_DEF = defineObject({
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
  ],
  permissions: { sales: { read: 'own' }, admin: { read: 'all' } },
});

describe('buildRowScope — tenant boundary (W3.2)', () => {
  it('own + tenant → owner predicate AND tenant predicate', () => {
    const frag = buildRowScope(TENANT_DEF, 'own', { id: 'u1', roles: ['sales'], tenantId: 't1' }, ['sales'])!;
    expect(frag.sql).toContain('"owner_id" = $1');
    expect(frag.sql).toContain('"tenant_id" = $2');
    expect(frag.params).toEqual(['u1', 't1']);
  });

  it('all + tenant → tenant predicate only', () => {
    const frag = buildRowScope(TENANT_DEF, 'all', { id: 'u1', roles: ['admin'], tenantId: 't1' }, ['admin'])!;
    expect(frag.sql).toBe('"tenant_id" = $1');
    expect(frag.params).toEqual(['t1']);
  });

  it('no tenantId → unchanged (single-tenant)', () => {
    const frag = buildRowScope(TENANT_DEF, 'own', { id: 'u1', roles: ['sales'] }, ['sales'])!;
    expect(frag.sql).toBe('"owner_id" = $1');
    // object without a tenant column is never tenant-scoped
    expect(buildRowScope(NO_TENANT_DEF, 'own', { id: 'u1', roles: ['sales'], tenantId: 't1' }, ['sales'])!.sql).toBe('"owner_id" = $1');
  });
});

describe('buildRlsPolicy — tenant predicate', () => {
  it('adds the tenant GUC clause when the object declares a tenant column', () => {
    const policy = buildRlsPolicy(TENANT_DEF)!;
    expect(policy).toContain("current_setting('weavekit.tenant_id', true) = \"tenant_id\"");
  });

  it('no tenant clause when the object has no tenant column', () => {
    expect(buildRlsPolicy(NO_TENANT_DEF)!).not.toContain('weavekit.tenant_id');
  });
});

describe('restricted SQL sets the tenant GUC', () => {
  it('SET LOCAL weavekit.tenant_id when the subject has a tenant', async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => { calls.push(sql); return { rows: [] }; },
      release: () => {},
    };
    const pool = { connect: async () => client };
    await executeRestrictedSql(pool as never, 'SELECT 1', [], {
      rls: { role: 'weavekit_query', subject: { id: 'u1', roles: [], tenantId: 't1' } },
      analyzer: { ensureLoaded: async () => {}, analyzeSelect: async () => ({ tables: [], resolvers: {}, columnRefs: [], joinCount: 0 }) } as never,
    });
    expect(calls.some((s) => s.includes("SET LOCAL weavekit.tenant_id = 't1'"))).toBe(true);
  });
});

describe('data-access find applies the tenant scope', () => {
  it('queries with the tenant predicate when the subject is tenant-scoped', async () => {
    const calls: { sql: string }[] = [];
    const pool = { query: async (sql: string) => { calls.push({ sql }); return sql.includes('COUNT(*)') ? { rows: [{ total: 0 }] } : { rows: [] }; } };
    const registry = new ObjectRegistry();
    registry.register(TENANT_DEF);
    const da = withRbac(createDataAccess());
    await da.find('lead', {}, { pool: pool as never, registry, principal: { kind: 'user', subject: { id: 'u1', roles: ['sales'], tenantId: 't1' } } });
    expect(calls.some((c) => c.sql.includes('"tenant_id"'))).toBe(true);
  });
});

describe('audit tenant scope (W3.3)', () => {
  it('queryAudit filters by tenant_id when a tenantId is given', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: sql.includes('count') ? [{ n: 0 }] : [] }; } };
    await queryAudit(pool as never, { tenantId: 't1' });
    expect(calls[0]!.sql).toContain('tenant_id = $1');
    expect(calls[0]!.params).toEqual(['t1']);
  });
});

describe('tenant write isolation (W3.2 fix)', () => {
  const registry = new ObjectRegistry();
  registry.register(TENANT_DEF);
  const admin = userPrincipal({ id: 'u1', roles: ['admin'], tenantId: 't1' });

  it('create forces the tenant column to the subject tenant', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: sql.includes('INSERT INTO "lead"') ? [{ __weave_record_key: 'x' }] : [], rowCount: 1 };
      },
      release: () => {},
    };
    const da = withRbac(createDataAccess());
    await da.create('lead', { id: 'x', tenant_id: 't9' }, { pool: { connect: async () => client } as never, registry, principal: admin });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO "lead"'))!;
    expect(insert.params).toContain('t1');
    expect(insert.params).not.toContain('t9');
  });

  it('update rejects moving a row to another tenant', async () => {
    const client = {
      query: async (sql: string) => (sql.includes('SELECT') ? { rows: [{ id: 'x', tenant_id: 't1', __weave_record_key: 'x' }] } : { rows: [], rowCount: 1 }),
      release: () => {},
    };
    const da = withRbac(createDataAccess());
    let caught: unknown;
    try {
      await da.update('lead', encodeRecordKey(['x']), { tenant_id: 't9' }, { pool: { connect: async () => client } as never, registry, principal: admin });
    } catch (error) {
      caught = error;
    }
    expect((caught as SchemaError).code).toBe('object.tenant.immutable');
  });
});
