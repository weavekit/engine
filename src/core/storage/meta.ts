import type { Pool } from 'pg';

const META_TABLE = 'weavekit_meta';

/** create the audit meta table if it does not exist */
export async function ensureMetaTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key text PRIMARY KEY, value text NOT NULL)`,
  );
}

/** upsert an audit record (e.g. schema.applied.<object> -> applied_at) */
export async function setMeta(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO ${META_TABLE} (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}
