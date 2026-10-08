import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, SchemaError } from '../../src/core/index.js';
import {
  QUERY_BUDGET_DEFAULTS,
  assertQueryBudget,
  countFilterConditions,
  createDataAccess,
  resolveQueryBudget,
  executeRestrictedSql,
} from '../../src/runtime/data-access/index.js';

describe('QueryBudget — resolve + merge', () => {
  it('absent → defaults; partial overrides; invalid falls back', () => {
    expect(resolveQueryBudget()).toEqual(QUERY_BUDGET_DEFAULTS);
    expect(resolveQueryBudget({ maxRows: 10 }).maxRows).toBe(10);
    expect(resolveQueryBudget({ maxRows: 10 }).maxFilters).toBe(QUERY_BUDGET_DEFAULTS.maxFilters);
    expect(resolveQueryBudget({ maxRows: -1 }).maxRows).toBe(QUERY_BUDGET_DEFAULTS.maxRows);
  });

  it('countFilterConditions counts keys and expands $or groups', () => {
    expect(countFilterConditions(undefined)).toBe(0);
    expect(countFilterConditions({ a: 1, b: 2 })).toBe(2);
    expect(countFilterConditions({ $or: [{ a: 1, b: 2 }, { c: 3 }] })).toBe(3);
  });

  it('assertQueryBudget throws over filters/sorts', () => {
    const budget = resolveQueryBudget({ maxFilters: 1, maxSorts: 1 });
    expect(() => assertQueryBudget({ filter: { a: 1 } }, budget)).not.toThrow();
    for (const opts of [
      { filter: { a: 1, b: 2 } },
      { sort: [{ field: 'a', dir: 'asc' as const }, { field: 'b', dir: 'asc' as const }] },
    ]) {
      let caught: unknown;
      try {
        assertQueryBudget(opts, budget);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaError);
      expect((caught as SchemaError).code).toBe('query.budget.exceeded');
    }
  });
});

describe('QueryBudget — data-access enforcement', () => {
  function harness() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('COUNT(*)')) return { rows: [{ total: 2 }] };
        return { rows: [{ id: 'a' }, { id: 'b' }] };
      },
    };
    const registry = new ObjectRegistry();
    registry.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }] });
    const principal = { kind: 'system' as const, capability: 'internal.admin' as const };
    return { pool, registry, principal, calls };
  }

  it('clamps rows to budget.maxRows', async () => {
    const { pool, registry, principal, calls } = harness();
    const da = createDataAccess({ budget: resolveQueryBudget({ maxRows: 5 }) });
    await da.find('lead', { limit: 999 }, { pool: pool as never, registry, principal });
    const page = calls.find((c) => !c.sql.includes('COUNT(*)'))!;
    expect(page.params[page.params.length - 2]).toBe(5);
  });

  it('throws when filters exceed the budget', async () => {
    const { pool, registry, principal } = harness();
    const da = createDataAccess({ budget: resolveQueryBudget({ maxFilters: 1 }) });
    let caught: unknown;
    try {
      await da.find('lead', { filter: { a: 1, b: 2 } }, { pool: pool as never, registry, principal });
    } catch (error) {
      caught = error;
    }
    expect((caught as SchemaError).code).toBe('query.budget.exceeded');
  });
});

describe('QueryBudget — restricted SQL enforcement', () => {
  const analyzer = {
    ensureLoaded: async () => {},
    analyzeSelect: async () => ({ tables: [], resolvers: {}, columnRefs: [], joinCount: 3 }),
  };
  const noConnectPool = { connect: () => { throw new Error('should not connect'); } };

  it('rejects over-long SQL before analyzing', async () => {
    let caught: unknown;
    try {
      await executeRestrictedSql(noConnectPool as never, `SELECT '${'x'.repeat(50)}'`, [], {
        budget: resolveQueryBudget({ maxSqlLength: 10 }),
        analyzer: analyzer as never,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as SchemaError).code).toBe('query.budget.exceeded');
  });

  it('rejects when joins exceed the budget', async () => {
    let caught: unknown;
    try {
      await executeRestrictedSql(noConnectPool as never, 'SELECT 1', [], {
        budget: resolveQueryBudget({ maxJoins: 2 }),
        analyzer: analyzer as never,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as SchemaError).code).toBe('query.budget.exceeded');
  });
});
