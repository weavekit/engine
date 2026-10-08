import { ObjectRegistry, SchemaError, migrate } from '../../core/index.js';
import type { FieldTypeRegistry, Locale, MigrationResult } from '../../core/index.js';
import {
  computeSchemaHash,
  syncMetadataCacheOn,
  writeSchemaRevision,
} from '../metadata/index.js';
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
  /** source git commit recorded on the schema revision (best-effort) */
  sourceCommit?: string;
  /** actor label recorded on the schema revision (best-effort) */
  actor?: string;
}

export interface SyncResult {
  registry: ObjectRegistry;
  files: LoadResult['files'];
  migration: MigrationResult;
  cache: { updated: string[]; removed: string[] };
  /** deterministic aggregate hash over the loaded schema files */
  schemaHash: string;
  /** schema revision row written in the same transaction (absent on dryRun) */
  revision?: { revision: number; created: boolean };
}

/**
 * One-way Git → PG metadata sync: read schema files → validate → migrate DDL
 * → write the PG metadata cache **+ schema revision in the same transaction**.
 *
 * The DDL, `schema.applied.*` meta, workflow-definition registration, metadata
 * cache and schema revision all commit or roll back as one unit (an advisory
 * xact lock serializes concurrent deploys). Returns the registry built from
 * disk so callers (e.g. createEngine) can reuse it.
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

  const schemaHash = computeSchemaHash(files);
  const entries = files.map((f) => ({ name: f.name, contentHash: f.contentHash, definition: f.object }));

  let cache: { updated: string[]; removed: string[] } = { updated: [], removed: [] };
  let revision: { revision: number; created: boolean } | undefined;

  const migration = await migrate(registry, {
    databaseUrl: url,
    dryRun: options.dryRun,
    rls: options.rls,
    onCommit:
      options.dryRun === true
        ? undefined
        : async (client) => {
            cache = await syncMetadataCacheOn(client, entries);
            revision = await writeSchemaRevision(client, {
              contentHash: schemaHash,
              objects: entries.map((e) => e.name),
              sourceCommit: options.sourceCommit,
              actor: options.actor,
            });
          },
  });

  return { registry, files, migration, cache, schemaHash, revision };
}
