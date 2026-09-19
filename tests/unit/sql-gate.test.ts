import { describe, it, expect, before } from '../helpers/test.js';
import { ObjectRegistry, ROW_SCOPE_MARKERS } from '../../src/core/index.js';
import { enforceSqlGates } from '../../src/runtime/data-access/index.js';
import { createSqlAnalyzer } from '../../src/runtime/sql-analyzer/index.js';
import type { SqlAnalyzer } from '../../src/runtime/sql-analyzer/index.js';

function buildRegistry(): ObjectRegistry {
  const reg = new ObjectRegistry();
  reg.register({
    name: 'lead',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'title', type: 'string' },
      { name: 'secret', type: 'string' },
      { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    ],
    permissions: {
      sales: { read: 'own', create: true, fields: { exclude: ['secret'] } },
      sales_analyst: { read: 'all', fields: { exclude: ['secret'] } },
      admin: { read: 'all' },
    },
  });
  reg.register({
    name: 'customer',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'name', type: 'string' },
    ],
    permissions: { sales: { read: 'all' } },
  });
  reg.buildGraph();
  return reg;
}

describe('SqlGate — read permission + teamId + field exclude (real analyzer)', () => {
  let analyzer: SqlAnalyzer;
  const reg = buildRegistry();

  before(async () => {
    analyzer = createSqlAnalyzer();
    await analyzer.ensureLoaded();
  });

  async function gate(sql: string, roles: string[], teamId?: string): Promise<string | undefined> {
    const analysis = await analyzer.analyzeSelect(sql);
    try {
      enforceSqlGates({ analysis, registry: reg, roles, teamId });
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown';
    }
  }

  it('role without read permission → script.query.denied', async () => {
    expect(await gate('SELECT * FROM lead', ['no_such_role'])).toBe('script.query.denied');
  });

  it('team read but no teamId → rbac.teamId.missing', async () => {
    const reg2 = new ObjectRegistry();
    reg2.register({
      name: 'team_lead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'team_id', type: 'string', [ROW_SCOPE_MARKERS.TEAM]: true },
      ],
      permissions: { ops: { read: 'team' } },
    });
    reg2.buildGraph();
    const analysis = await analyzer.analyzeSelect('SELECT * FROM team_lead');
    let code: string | undefined;
    try {
      enforceSqlGates({ analysis, registry: reg2, roles: ['ops'] });
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('rbac.teamId.missing');
    // with teamId → passes
    const ok = await analyzer.analyzeSelect('SELECT * FROM team_lead');
    expect(() => enforceSqlGates({ analysis: ok, registry: reg2, roles: ['ops'], teamId: 't1' })).not.toThrow();
  });

  it('field exclude: bare column/qualified column/function argument hit → script.query.denied', async () => {
    expect(await gate('SELECT secret FROM lead', ['sales'])).toBe('script.query.denied');
    expect(await gate('SELECT l.secret FROM lead l', ['sales'])).toBe('script.query.denied');
    expect(await gate('SELECT upper(secret) FROM lead', ['sales'])).toBe('script.query.denied');
    expect(await gate('SELECT id FROM lead WHERE secret = $1', ['sales'])).toBe('script.query.denied');
  });

  it('field exclude: projection/qualified * hit → script.query.denied; count(*) allowed', async () => {
    expect(await gate('SELECT * FROM lead', ['sales'])).toBe('script.query.denied');
    expect(await gate('SELECT lead.* FROM lead', ['sales'])).toBe('script.query.denied');
    expect(await gate('SELECT count(*) FROM lead', ['sales'])).toBeUndefined();
  });

  it('non-exclude column allowed', async () => {
    expect(await gate('SELECT id, title FROM lead', ['sales'])).toBeUndefined();
    expect(await gate('SELECT count(title) FROM lead', ['sales'])).toBeUndefined();
  });

  it('role without exclude (admin) allows everything', async () => {
    expect(await gate('SELECT secret FROM lead', ['admin'])).toBeUndefined();
    expect(await gate('SELECT * FROM lead', ['admin'])).toBeUndefined();
  });

  it('cross-table: only references customer which has no exclude → allowed', async () => {
    expect(await gate('SELECT c.name FROM lead l JOIN customer c ON l.customer_id = c.id', ['sales'])).toBeUndefined();
    expect(await gate('SELECT c.name FROM customer c', ['sales'])).toBeUndefined();
  });

  it('non-registry table (other schema/system table) → fail-closed script.query.denied (H2)', async () => {
    expect(await gate('SELECT * FROM public.audit_log', ['sales'])).toBe('script.query.denied');
    expect(await gate('SELECT * FROM pg_catalog.pg_class', ['sales'])).toBe('script.query.denied');
  });
});
