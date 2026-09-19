import type { Pool } from 'pg';

const TABLE = 'weavekit_metadata';

export interface MetadataRow {
  objectName: string;
  contentHash: string;
  appliedAt: Date;
}

export interface MetadataEntry {
  name: string;
  contentHash: string;
  definition: unknown;
}

/** create the metadata cache table if it does not exist */
export async function ensureMetadataTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       object_name text PRIMARY KEY,
       content_hash text NOT NULL,
       definition jsonb NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/** read the whole metadata cache keyed by object name */
export async function readMetadataCache(pool: Pool): Promise<Map<string, MetadataRow>> {
  const result = await pool.query(
    `SELECT object_name, content_hash, applied_at FROM ${TABLE}`,
  );
  const map = new Map<string, MetadataRow>();
  for (const row of result.rows as { object_name: string; content_hash: string; applied_at: Date }[]) {
    map.set(row.object_name, {
      objectName: row.object_name,
      contentHash: row.content_hash,
      appliedAt: row.applied_at,
    });
  }
  return map;
}

/** upsert metadata cache entries inside a transaction */
export async function writeMetadataCache(pool: Pool, entries: MetadataEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      await client.query(
        `INSERT INTO ${TABLE} (object_name, content_hash, definition, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (object_name) DO UPDATE
           SET content_hash = EXCLUDED.content_hash,
               definition = EXCLUDED.definition,
               updated_at = now()`,
        [entry.name, entry.contentHash, JSON.stringify(entry.definition)],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** drop metadata cache rows for objects that no longer exist on disk */
export async function invalidateMetadata(pool: Pool, names: string[]): Promise<void> {
  if (names.length === 0) return;
  await pool.query(`DELETE FROM ${TABLE} WHERE object_name = ANY($1)`, [names]);
}

/**
 * Bring the metadata cache in sync with the loaded schema files: upsert the
 * current definitions and prune rows for removed objects. Returns which
 * objects were updated (content hash changed) and removed.
 */
export async function syncMetadataCache(
  pool: Pool,
  files: MetadataEntry[],
): Promise<{ updated: string[]; removed: string[] }> {
  await ensureMetadataTable(pool);
  const existing = await readMetadataCache(pool);
  const updated = files.filter((f) => existing.get(f.name)?.contentHash !== f.contentHash).map((f) => f.name);
  const removed = [...existing.keys()].filter((name) => !files.some((f) => f.name === name));
  await writeMetadataCache(pool, files);
  await invalidateMetadata(pool, removed);
  return { updated, removed };
}
