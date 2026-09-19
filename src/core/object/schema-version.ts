/**
 * `schema.json` on-disk format version — single source of truth.
 *
 * Every object file may carry a top-level `schemaVersion` (a positive integer).
 * Files written before versioning existed are treated as {@link LEGACY_SCHEMA_FORMAT_VERSION}.
 * Bump {@link SCHEMA_FORMAT_VERSION} and register a migration in `migrations.ts`
 * whenever the on-disk shape changes; `weave schema:upgrade` stamps files to the
 * current version and the loader reads older files through the same migrations.
 */
export const SCHEMA_FORMAT_VERSION = 1 as const;
export type SchemaFormatVersion = typeof SCHEMA_FORMAT_VERSION;

/** implicit version of files that predate the `schemaVersion` field. */
export const LEGACY_SCHEMA_FORMAT_VERSION = 0 as const;
