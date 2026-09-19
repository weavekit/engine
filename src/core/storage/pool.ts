import pg from 'pg';

/** create a pg connection pool from a DATABASE_URL connection string */
export function createPool(databaseUrl: string, options: pg.PoolConfig = {}): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, ...options });
}
