import { createHash } from 'node:crypto';
import { SYSTEM_TABLES, type SqlQueryable } from '../../core/index.js';

/**
 * Global schema revisions (`weavekit_schema_revision`): an append-only history
 * anchored on a deterministic aggregate content hash over the schema files.
 * This is the "schema revision = database revision = runtime revision" anchor —
 * Git / DB / metadata cache / runtime can all be compared to one id.
 */
export interface SchemaRevision {
  revision: number;
  contentHash: string;
  parentRevision: number | null;
  sourceCommit: string | null;
  actor: string | null;
  objects: string[];
  status: string;
  createdAt: Date;
}

export interface SchemaRevisionInput {
  contentHash: string;
  sourceCommit?: string;
  actor?: string;
  objects: readonly string[];
  status?: string;
}

const TABLE = SYSTEM_TABLES.SCHEMA_REVISION;

/** deterministic, order-independent aggregate hash over the per-object content hashes */
export function computeSchemaHash(
  files: readonly { name: string; contentHash: string }[],
): string {
  const canonical = [...files]
    .map((f) => `${f.name}:${f.contentHash}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function rowToRevision(row: Record<string, unknown>): SchemaRevision {
  const parent = row.parent_revision;
  return {
    revision: Number(row.revision),
    contentHash: String(row.content_hash),
    parentRevision: parent === null || parent === undefined ? null : Number(parent),
    sourceCommit: (row.source_commit as string | null) ?? null,
    actor: (row.actor as string | null) ?? null,
    objects: (row.objects as string[] | null) ?? [],
    status: String(row.status),
    createdAt: row.created_at as Date,
  };
}

/** the most recent revision, or null when none has been recorded */
export async function latestSchemaRevision(db: SqlQueryable): Promise<SchemaRevision | null> {
  const res = await db.query(`SELECT * FROM ${TABLE} ORDER BY revision DESC LIMIT 1`);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToRevision(row);
}

/**
 * Record a schema revision. Idempotent by content hash: when the latest
 * revision already carries the same hash, no new row is written and the
 * existing id is returned. `parent_revision` links the chain.
 */
export async function writeSchemaRevision(
  db: SqlQueryable,
  input: SchemaRevisionInput,
): Promise<{ revision: number; created: boolean }> {
  const latest = await latestSchemaRevision(db);
  if (latest !== null && latest.contentHash === input.contentHash) {
    return { revision: latest.revision, created: false };
  }
  const res = await db.query(
    `INSERT INTO ${TABLE} (content_hash, parent_revision, source_commit, actor, objects, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING revision`,
    [
      input.contentHash,
      latest?.revision ?? null,
      input.sourceCommit ?? null,
      input.actor ?? null,
      JSON.stringify(input.objects),
      input.status ?? 'active',
    ],
  );
  return { revision: Number((res.rows[0] as { revision: number }).revision), created: true };
}
