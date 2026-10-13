import pg from 'pg';
import { assertSchemaName } from './schema-scope.js';
import { sqlIdent } from './sql-literals.js';

/** create a pg connection pool from a DATABASE_URL connection string */
export function createPool(databaseUrl: string, options: pg.PoolConfig = {}): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, ...options });
}

/**
 * Pool config that makes the engine's own tables resolvable when `systemSchema`
 * is set, **without disturbing the connection's existing `search_path`**.
 *
 * The runtime references its `weavekit_*` / record-meta / link tables unqualified
 * (only `migrate` DDL uses explicit qualification), so they must be on the search
 * path. Replacing the path via `options` would drop the object schema — which may
 * come from the URL `options`, the role default or `PGOPTIONS` (and a later
 * `-c search_path` wins anyway, so appending inside `options` does not work).
 *
 * Instead we **append** the system schema to whatever path is already in effect,
 * per physical connection. `pg-pool` awaits `onConnect` before handing the client
 * out, so the setting is present for every query; a failure rejects acquisition
 * (fail-closed). `undefined` → the plain pool.
 */
export function searchPathOptions(systemSchema?: string): pg.PoolConfig {
  if (systemSchema === undefined) return {};
  assertSchemaName(systemSchema);
  const schema = sqlIdent(systemSchema);
  return {
    onConnect: async (client) => {
      const res = await client.query<{ path: string }>("SELECT current_setting('search_path') AS path");
      const current = res.rows[0]?.path?.trim() ?? '';
      const next = current === '' ? schema : `${current}, ${schema}`;
      await client.query('SELECT set_config(\'search_path\', $1, false)', [next]);
    },
  };
}
