import pg from 'pg';

/** create a pg connection pool from a DATABASE_URL connection string */
export function createPool(databaseUrl: string, options: pg.PoolConfig = {}): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, ...options });
}

/**
 * Pool config that appends `systemSchema` to `search_path` (after the object
 * schema), so unqualified engine-table references (`weavekit_*`, record-meta,
 * link tables) resolve to the dedicated schema while customer/identity tables
 * still resolve to the object schema first. `undefined` → the default path.
 */
export function searchPathOptions(systemSchema?: string): pg.PoolConfig {
  return systemSchema === undefined ? {} : { options: `-c search_path="$user",public,${systemSchema}` };
}
