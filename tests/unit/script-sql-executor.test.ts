import { describe, it, expect } from '../helpers/test.js';import type { Pool } from 'pg';
import { SchemaError } from '../../src/core/index.js';
import { executeRestrictedSql } from '../../src/runtime/data-access/index.js';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function mockPool(): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/statement_timeout/.test(sql)) return { rows: [] };
      return { rows: [{ id: 'L1' }] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, calls };
}

describe('executeRestrictedSql — restricted SQL gate', () => {
  it('non-SELECT statement rejected (script.query.invalid)', async () => {
    const { pool } = mockPool();
    try {
      await executeRestrictedSql(pool, 'UPDATE lead SET status = $1', ['x']);
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as SchemaError).code).toBe('script.query.invalid');
    }
  });

  it('multiple statements rejected (semicolon)', async () => {
    const { pool } = mockPool();
    try {
      await executeRestrictedSql(pool, "SELECT 1; DROP TABLE lead", []);
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as SchemaError).code).toBe('script.query.invalid');
    }
  });

  it('SELECT subquery wrapping + LIMIT cap + parameter offset', async () => {
    const { pool, calls } = mockPool();
    const result = await executeRestrictedSql(pool, 'SELECT * FROM lead WHERE status = $1', ['open'], { maxRows: 50 });
    expect(result.rows).toEqual([{ id: 'L1' }]);
    const selectCall = calls.find((c) => c.sql.includes('__restricted__'))!;
    expect(selectCall.sql).toContain('SELECT * FROM (SELECT * FROM lead WHERE status = $1) AS __restricted__ LIMIT $2');
    expect(selectCall.params).toEqual(['open', 50]);
  });

  it('executable after stripping trailing single semicolon', async () => {
    const { pool, calls } = mockPool();
    await executeRestrictedSql(pool, 'SELECT * FROM lead;', []);
    expect(calls.some((c) => c.sql.includes('__restricted__'))).toBe(true);
  });

  it('transaction wrapping: BEGIN → SET LOCAL statement_timeout → SELECT → COMMIT', async () => {
    const { pool, calls } = mockPool();
    await executeRestrictedSql(pool, 'SELECT * FROM lead', [], { timeoutMs: 1500 });
    const seq = calls.map((c) => c.sql);
    expect(seq[0]).toBe('BEGIN');
    expect(seq[1]).toContain('SET LOCAL statement_timeout = 1500');
    expect(seq.some((s) => s.includes('__restricted__'))).toBe(true);
    expect(seq[seq.length - 1]).toBe('COMMIT');
  });

  it('rls: SET LOCAL ROLE + weavekit GUC carries subject (with teamId), single quotes escaped', async () => {
    const { pool, calls } = mockPool();
    await executeRestrictedSql(pool, 'SELECT * FROM lead', [], {
      timeoutMs: 1500,
      rls: { role: 'weavekit_query', subject: { id: "u'1", roles: ['sales', 'admin'], teamId: 't1' } },
    });
    const seq = calls.map((c) => c.sql);
    expect(seq[0]).toBe('BEGIN');
    expect(seq[1]).toContain('SET LOCAL statement_timeout = 1500');
    expect(seq[2]).toBe('SET LOCAL ROLE weavekit_query');
    expect(seq[3]).toBe("SET LOCAL weavekit.actor_id = 'u''1'");
    expect(seq[4]).toBe("SET LOCAL weavekit.roles = 'sales,admin'");
    expect(seq[5]).toBe("SET LOCAL weavekit.team_id = 't1'");
    expect(seq[seq.length - 1]).toBe('COMMIT');
  });

  it('rls: invalid role name rejected', async () => {
    const { pool } = mockPool();
    try {
      await executeRestrictedSql(pool, 'SELECT 1', [], { rls: { role: 'bad role; DROP', subject: { id: 'u', roles: [] } } });
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as SchemaError).code).toBe('script.query.invalid');
    }
  });
});
