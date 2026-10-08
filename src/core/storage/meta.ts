import type { SqlQueryable } from './queryable.js';

const META_TABLE = 'weavekit_meta';

/**
 * Upsert a meta record (e.g. `schema.applied.<object>` -> applied_at).
 * The table is created by `weave migrate` — the runtime never runs DDL.
 * Takes any {@link SqlQueryable} so it can run inside the deploy transaction.
 */
export async function setMeta(db: SqlQueryable, key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO ${META_TABLE} (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

/** read a meta value (null when the key is absent) */
export async function getMeta(db: SqlQueryable, key: string): Promise<string | null> {
  const res = await db.query(`SELECT value FROM ${META_TABLE} WHERE key = $1`, [key]);
  return (res.rows[0] as { value: string } | undefined)?.value ?? null;
}
