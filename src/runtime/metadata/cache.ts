import type { Pool } from 'pg';
import type { SqlQueryable } from '../../core/index.js';

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

/** read the whole metadata cache keyed by object name */
export async function readMetadataCache(db: SqlQueryable): Promise<Map<string, MetadataRow>> {
  const result = await db.query(
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

/** upsert metadata cache entries on an existing SqlQueryable (no transaction management) */
export async function writeMetadataCacheOn(db: SqlQueryable, entries: MetadataEntry[]): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) {
    await db.query(
      `INSERT INTO ${TABLE} (object_name, content_hash, definition, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (object_name) DO UPDATE
         SET content_hash = EXCLUDED.content_hash,
             definition = EXCLUDED.definition,
             updated_at = now()`,
      [entry.name, entry.contentHash, JSON.stringify(entry.definition)],
    );
  }
}

/** upsert metadata cache entries inside its own transaction */
export async function writeMetadataCache(pool: Pool, entries: MetadataEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await writeMetadataCacheOn(client, entries);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** drop metadata cache rows for objects that no longer exist on disk */
export async function invalidateMetadata(db: SqlQueryable, names: string[]): Promise<void> {
  if (names.length === 0) return;
  await db.query(`DELETE FROM ${TABLE} WHERE object_name = ANY($1)`, [names]);
}

/**
 * Bring the metadata cache in sync on an existing SqlQueryable (no transaction
 * management) — used inside the atomic deploy transaction. Returns which
 * objects were updated (content hash changed) and removed.
 */
export async function syncMetadataCacheOn(
  db: SqlQueryable,
  files: MetadataEntry[],
): Promise<{ updated: string[]; removed: string[] }> {
  const existing = await readMetadataCache(db);
  const updated = files.filter((f) => existing.get(f.name)?.contentHash !== f.contentHash).map((f) => f.name);
  const removed = [...existing.keys()].filter((name) => !files.some((f) => f.name === name));
  await writeMetadataCacheOn(db, files);
  await invalidateMetadata(db, removed);
  return { updated, removed };
}

/**
 * Bring the metadata cache in sync with the loaded schema files: upsert the
 * current definitions and prune rows for removed objects. Runs in one
 * transaction.
 */
export async function syncMetadataCache(
  pool: Pool,
  files: MetadataEntry[],
): Promise<{ updated: string[]; removed: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await syncMetadataCacheOn(client, files);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
