import { ObjectRegistry, SchemaError, createPool, migrate } from '../../core/index.js';
import type { FieldTypeRegistry, Locale, MigrationResult } from '../../core/index.js';
import { syncMetadataCache } from '../metadata/index.js';
import { loadSchemaDir } from './loader.js';
import type { LoadResult } from './loader.js';

export interface SyncSchemaOptions {
  /** project root containing `objects/**` */
  dir: string;
  /** postgres connection string; falls back to process.env.DATABASE_URL */
  databaseUrl?: string;
  /** generate DDL + report without executing or writing the metadata cache */
  dryRun?: boolean;
  /** enable row-level security for the restricted-SQL role (`this.db.query`) */
  rls?: { role: string };
  locale?: Locale;
  allowedFieldTypes?: readonly string[];
  /** effective field-type registry (built-ins + user registrations) */
  fieldTypes?: FieldTypeRegistry;
}

export interface SyncResult {
  registry: ObjectRegistry;
  files: LoadResult['files'];
  migration: MigrationResult;
  cache: { updated: string[]; removed: string[] };
}

/**
 * One-way Git → PG metadata sync (MVP simplification): read schema files →
 * validate → migrate DDL → write the PG metadata cache. Returns the registry
 * built from disk so callers (e.g. createEngine) can reuse it.
 */
export async function syncSchema(options: SyncSchemaOptions): Promise<SyncResult> {
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  if (url === undefined) {
    throw new SchemaError('engine.databaseUrl.missing', {}, options.locale);
  }

  const { registry, files } = await loadSchemaDir(options.dir, {
    locale: options.locale,
    allowedFieldTypes: options.allowedFieldTypes,
    fieldTypes: options.fieldTypes,
  });
  registry.buildGraph({ locale: options.locale });
  const migration = await migrate(registry, {
    databaseUrl: url,
    dryRun: options.dryRun,
    rls: options.rls,
  });

  let cache: { updated: string[]; removed: string[] } = { updated: [], removed: [] };
  if (!options.dryRun) {
    const pool = createPool(url);
    try {
      cache = await syncMetadataCache(
        pool,
        files.map((f) => ({ name: f.name, contentHash: f.contentHash, definition: f.object })),
      );
    } catch (error) {
      // The DDL (migrate) above is already committed and idempotent. The cache
      // write is a separate step — on failure surface it loudly (never a
      // silent partial sync leaving Git source of truth vs PG cache drifted);
      // a re-run of sync converges.
      if (error instanceof SchemaError) throw error;
      throw new Error(
        `metadata cache write failed after DDL applied (re-run sync to converge): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      await pool.end();
    }
  }

  return { registry, files, migration, cache };
}
