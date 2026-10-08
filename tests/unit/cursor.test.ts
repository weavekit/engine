import { describe, it, expect } from '../helpers/test.js';
import { SchemaError } from '../../src/core/index.js';
import { ObjectRegistry } from '../../src/core/index.js';
import { createDataAccess, decodeCursor, encodeCursor } from '../../src/runtime/data-access/index.js';

describe('cursor codec', () => {
  it('round-trips key values', () => {
    expect(decodeCursor(encodeCursor(['abc']))).toEqual(['abc']);
    expect(decodeCursor(encodeCursor([42]))).toEqual([42]);
  });

  it('rejects malformed / foreign cursors with a 400 param error', () => {
    for (const bad of ['not-base64!!', Buffer.from('{"v":99,"k":["x"]}').toString('base64url')]) {
      let caught: unknown;
      try {
        decodeCursor(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaError);
      expect((caught as SchemaError).code).toBe('http.param.invalid');
    }
  });
});

describe('find — keyset cursor', () => {
  function harness(rows: Record<string, unknown>[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('COUNT(*)')) return { rows: [{ total: 5 }] };
        return { rows };
      },
    };
    const registry = new ObjectRegistry();
    registry.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }] });
    const da = createDataAccess();
    return { da, registry, pool, calls };
  }

  it('fetches pk > cursor ordered by pk and returns hasMore/nextCursor', async () => {
    const { da, registry, pool, calls } = harness([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const res = await da.find('lead', { cursor: encodeCursor(['0']), limit: 2 }, { pool: pool as never, registry });

    const page = calls.find((c) => !c.sql.includes('COUNT(*)'))!;
    expect(page.sql).toContain('"id" >');
    expect(page.sql).toContain('ORDER BY "id"');
    // limit+1 probe row fetched
    expect(page.params[page.params.length - 2]).toBe(3);
    expect(res.rows).toHaveLength(2);
    expect(res.hasMore).toBe(true);
    expect(res.total).toBe(5);
    expect(decodeCursor(res.nextCursor!)).toEqual(['b']);
  });

  it('no more rows → hasMore false, no nextCursor', async () => {
    const { da, registry, pool } = harness([{ id: 'a' }]);
    const res = await da.find('lead', { cursor: encodeCursor(['0']), limit: 2 }, { pool: pool as never, registry });
    expect(res.rows).toHaveLength(1);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeUndefined();
  });

  it('offset mode reports hasMore from total', async () => {
    const { da, registry, pool } = harness([{ id: 'a' }, { id: 'b' }]);
    const res = await da.find('lead', { limit: 2, offset: 0 }, { pool: pool as never, registry });
    expect(res.hasMore).toBe(true); // 0 + 2 < 5
  });
});
