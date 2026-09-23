import type { DataAccessContext } from './types.js';

/**
 * `withTx` — cross-operation atomic execution. Leases a pooled client,
 * opens a transaction and re-enters the callback with a context that carries
 * that connection as `client`, so nested data-access calls reuse the
 * transaction instead of opening their own (see `DefaultObjectDataAccess`
 * owned-connection handling). Commits on success, rolls back on throw,
 * releases in `finally`. Nested calls are safe: when the context already
 * carries a `client`, the callback runs directly inside the outer transaction.
 */
export async function withTx<T>(
  ctx: DataAccessContext,
  fn: (txCtx: DataAccessContext) => Promise<T>,
): Promise<T> {
  if (ctx.client !== undefined) {
    return fn(ctx);
  }
  const client = await ctx.pool.connect();
  const txCtx: DataAccessContext = { ...ctx, client };
  try {
    await client.query('BEGIN');
    const result = await fn(txCtx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
