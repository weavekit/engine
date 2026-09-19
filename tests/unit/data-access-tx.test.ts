import { describe, it, expect } from '../helpers/test.js';
import { withTx } from '../../src/runtime/data-access/index.js';
import type { DataAccessContext } from '../../src/runtime/data-access/index.js';

/** fake pool whose client records every query/release and can fail on demand */
function fakePool() {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(String(sql));
      return { rows: [] };
    },
    release: () => {
      queries.push('release');
    },
  };
  const pool = { connect: async () => client } as unknown as DataAccessContext['pool'];
  return { pool, client, queries };
}

const baseCtx = (pool: DataAccessContext['pool']): DataAccessContext => ({ pool, registry: {} as never });

describe('withTx — cross-operation transaction primitive (D1)', () => {
  it('success path: BEGIN → fn(ctx.client) → COMMIT → release', async () => {
    const { pool, client, queries } = fakePool();
    let sawClient: unknown;
    await withTx(baseCtx(pool), async (txCtx) => {
      sawClient = txCtx.client;
      expect(txCtx.pool).toBe(pool);
    });
    expect(sawClient).toBe(client);
    expect(queries).toEqual(['BEGIN', 'COMMIT', 'release']);
  });

  it('failure path: BEGIN → fn throws → ROLLBACK → release, error propagated', async () => {
    const { pool, queries } = fakePool();
    let caught: unknown;
    try {
      await withTx(baseCtx(pool), async () => {
        throw new Error('boom');
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe('boom');
    expect(queries).toEqual(['BEGIN', 'ROLLBACK', 'release']);
  });

  it('nested withTx reuses outer transaction (no extra BEGIN)', async () => {
    const { pool, queries } = fakePool();
    await withTx(baseCtx(pool), async (outer) => {
      await withTx(outer, async (inner) => {
        expect(inner.client).toBe(outer.client);
      });
    });
    expect(queries).toEqual(['BEGIN', 'COMMIT', 'release']);
  });

  it('ctx.client already present → run fn directly (no BEGIN/no release)', async () => {
    const { pool, client, queries } = fakePool();
    await withTx({ ...baseCtx(pool), client } as DataAccessContext, async (ctx) => {
      expect(ctx.client).toBe(client);
    });
    expect(queries).toEqual([]);
  });

  it('fn return value propagated', async () => {
    const { pool } = fakePool();
    const result = await withTx(baseCtx(pool), async () => 'value');
    expect(result).toBe('value');
  });
});
