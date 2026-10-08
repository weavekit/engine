import type { Pool, PoolClient } from 'pg';

/** execute DDL statements on an existing client (caller owns the transaction) */
export async function applyStatementsOn(client: PoolClient, statements: string[]): Promise<void> {
  for (const sql of statements) await client.query(sql);
}

/** execute DDL statements inside a single transaction */
export async function applyStatements(pool: Pool, statements: string[]): Promise<void> {
  if (statements.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyStatementsOn(client, statements);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
