import type { Pool } from 'pg';

/** execute DDL statements inside a single transaction */
export async function applyStatements(pool: Pool, statements: string[]): Promise<void> {
  if (statements.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of statements) await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
