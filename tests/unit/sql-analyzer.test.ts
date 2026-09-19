import { describe, it, expect, before, after } from '../helpers/test.js';
import { createSqlAnalyzer } from '../../src/runtime/sql-analyzer/index.js';
import type { SqlAnalyzer } from '../../src/runtime/sql-analyzer/index.js';

describe('SqlAnalyzer — table/column reference extraction (pgsql-parser WASM real PG parser)', () => {
  let analyzer: SqlAnalyzer;

  before(async () => {
    analyzer = createSqlAnalyzer();
    await analyzer.ensureLoaded();
  });
  after(() => {});

  it('parses basic SELECT: tables + aliases + column references', async () => {
    const r = await analyzer.analyzeSelect('SELECT l.id, c.name FROM lead l JOIN customer c ON l.customer_id = c.id');
    expect(r.tables).toEqual(expect.arrayContaining(['lead', 'customer']));
    expect(r.resolvers).toMatchObject({ lead: 'lead', l: 'lead', customer: 'customer', c: 'customer' });
    expect(r.columnRefs).toEqual(
      expect.arrayContaining([
        { qualifier: 'l', column: 'id', star: false },
        { qualifier: 'c', column: 'name', star: false },
        { qualifier: 'l', column: 'customer_id', star: false },
        { qualifier: 'c', column: 'id', star: false },
      ]),
    );
  });

  it('star semantics: projection * and t.* are ColumnRef, count(*) is agg_star with no column reference', async () => {
    const star = await analyzer.analyzeSelect('SELECT lead.*, * FROM lead');
    expect(star.columnRefs).toEqual(
      expect.arrayContaining([
        { qualifier: 'lead', column: '*', star: true },
        { qualifier: undefined, column: '*', star: true },
      ]),
    );

    const count = await analyzer.analyzeSelect('SELECT count(*) FROM lead');
    expect(count.columnRefs.some((c) => c.star)).toBe(false);

    const agg = await analyzer.analyzeSelect('SELECT json_agg(lead.*) FROM lead');
    expect(agg.columnRefs.some((c) => c.star && c.qualifier === 'lead')).toBe(true);
  });

  it('bare column and function argument column references (upper(secret) / count(secret))', async () => {
    const r = await analyzer.analyzeSelect('SELECT upper(secret), count(secret) FROM lead');
    const cols = r.columnRefs.filter((c) => c.column === 'secret');
    expect(cols.length).toBeGreaterThanOrEqual(2);
    expect(cols.every((c) => c.star === false)).toBe(true);
  });

  it('column references in WHERE/ORDER BY/subquery positions covered across full tree', async () => {
    const r = await analyzer.analyzeSelect(
      "SELECT t.amount FROM (SELECT amount FROM lead WHERE owner_id = 'u1') t ORDER BY t.amount",
    );
    const cols = r.columnRefs.map((c) => c.column);
    expect(cols).toContain('amount');
    expect(cols).toContain('owner_id');
  });

  it('ensureLoaded is idempotent and repeatable', async () => {
    await analyzer.ensureLoaded();
    await analyzer.ensureLoaded();
    const r = await analyzer.analyzeSelect('SELECT 1');
    expect(r.tables).toEqual([]);
  });
});

describe('SqlAnalyzer — fail-closed (parse failure/non-SELECT/multiple statements all rejected)', () => {
  let analyzer: SqlAnalyzer;

  before(async () => {
    analyzer = createSqlAnalyzer();
  });

  it('non-SELECT (INSERT/UPDATE/DELETE/CREATE) → script.query.invalid', async () => {
    for (const sql of ['INSERT INTO lead (id) VALUES (1)', 'UPDATE lead SET x = 1', 'DELETE FROM lead', 'CREATE TABLE t (id int)']) {
      let caught: Error | undefined;
      try {
        await analyzer.analyzeSelect(sql);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect((caught as { code?: string }).code).toBe('script.query.invalid');
    }
  });

  it('multiple statements / syntax error → script.query.invalid', async () => {
    for (const sql of ['SELECT 1; SELECT 2', 'SELECT * FROM', "SELECT 'unclosed"]) {
      let caught: Error | undefined;
      try {
        await analyzer.analyzeSelect(sql);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect((caught as { code?: string }).code).toBe('script.query.invalid');
    }
  });
});
