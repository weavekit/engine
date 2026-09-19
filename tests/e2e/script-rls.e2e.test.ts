import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, ROW_SCOPE_MARKERS, createPool, migrate } from '../../src/core/index.js';
import {
  createDataAccess,
  enforceSqlGates,
  executeRestrictedSql,
  withRbac,
} from '../../src/runtime/data-access/index.js';
import { createSqlAnalyzer } from '../../src/runtime/sql-analyzer/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;
const RLS_ROLE = 'weavekit_query';

maybe('Script restricted SQL RLS E2E (native PG RLS + real PG)', () => {
  it('migrate rls → create tables+role+policy+grant; db.query row-level scoping; parity', async () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'lead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'title', type: 'string' },
        { name: 'secret', type: 'string' },
        { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
        { name: 'team_id', type: 'string', [ROW_SCOPE_MARKERS.TEAM]: true },
      ],
      permissions: {
        sales: { read: 'own', fields: { exclude: ['secret'] } },
        ops: { read: 'team' },
        admin: { read: 'all' },
      },
    });
    reg.buildGraph();

    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS lead CASCADE');
      const migration = await migrate(reg, { databaseUrl: url!, rls: { role: RLS_ROLE } });
      // RLS DDL emitted: ENABLE RLS + CREATE POLICY + GRANT SELECT + role provisioning
      expect(migration.warnings).toEqual([]);
      expect(migration.statements.some((s) => s.includes('ENABLE ROW LEVEL SECURITY'))).toBe(true);
      expect(migration.statements.some((s) => s.includes('CREATE POLICY weavekit_read_lead'))).toBe(true);
      expect(migration.statements.some((s) => s.includes(`GRANT SELECT ON "lead" TO ${RLS_ROLE}`))).toBe(true);

      const rlsOn = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'lead'");
      expect(rlsOn.rows[0].relrowsecurity).toBe(true);

      // seed data: u1 owns L1/L2, u2 owns L3; team t1 has L1/L3
      await pool.query(
        `INSERT INTO lead (id, title, secret, owner_id, team_id) VALUES
         ('L1','a','s1','u1','t1'),('L2','b','s2','u1','t2'),('L3','c','s3','u2','t1')`,
      );

      const SQL = 'SELECT id, title FROM lead'; // no star, no excluded column → gates pass, test RLS row-level
      const ids = async (subject: { id: string; roles: string[]; teamId?: string }): Promise<string[]> => {
        const analysis = await createSqlAnalyzer().analyzeSelect(SQL);
        enforceSqlGates({ analysis, registry: reg, roles: subject.roles, teamId: subject.teamId });
        const res = await executeRestrictedSql(pool, SQL, [], { rls: { role: RLS_ROLE, subject } });
        return (res.rows as Array<{ id: string }>).map((r) => r.id);
      };

      // own row-level: sales/u1 sees only self
      expect((await ids({ id: 'u1', roles: ['sales'] })).sort()).toEqual(['L1', 'L2']);

      // team row-level: ops + teamId t1 → L1/L3
      expect((await ids({ id: 'u9', roles: ['ops'], teamId: 't1' })).sort()).toEqual(['L1', 'L3']);

      // all: admin sees everything
      expect((await ids({ id: 'a1', roles: ['admin'] })).sort()).toEqual(['L1', 'L2', 'L3']);

      // RLS fail-closed: GUC all empty → policies all false → 0 rows (execute directly bypassing gates)
      const empty = await executeRestrictedSql(pool, SQL, [], {
        rls: { role: RLS_ROLE, subject: { id: 'u1', roles: [] } },
      });
      expect((empty.rows as Array<{ id: string }>).length).toBe(0);

      // idempotent: rerun rls emits no RLS statements
      const again = await migrate(reg, { databaseUrl: url!, rls: { role: RLS_ROLE } });
      expect(again.statements).toEqual([]);

      // parity: sales/u1 via db.objects (app-layer rowScope) vs db.query (RLS) row sets match
      const dataAccess = withRbac(createDataAccess({}));
      const own = await dataAccess.find(
        'lead',
        {},
        { pool, registry: reg, subject: { id: 'u1', roles: ['sales'], teamId: 't1' } },
      );
      const objectsIds = (own.rows as Array<{ id: string }>).map((r) => r.id).sort();
      const queryIds = (await ids({ id: 'u1', roles: ['sales'], teamId: 't1' })).sort();
      expect(queryIds).toEqual(objectsIds);
    } finally {
      await pool.query('DROP TABLE IF EXISTS lead CASCADE');
      await pool.end();
    }
  }, 60000);
});
