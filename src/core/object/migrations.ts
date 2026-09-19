import type { Locale } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import { LEGACY_SCHEMA_FORMAT_VERSION, SCHEMA_FORMAT_VERSION } from './schema-version.js';

type RawObject = Record<string, unknown>;

/**
 * On-disk format migrations: `from`-version → a transform producing version+1.
 * Append a step here whenever {@link SCHEMA_FORMAT_VERSION} is bumped. Steps
 * must be pure (they may not read files or the database).
 */
const MIGRATIONS: Record<number, (raw: RawObject) => RawObject> = {
  // v0 (unversioned) → v1: make the format version explicit.
  0: (raw) => ({ ...raw, schemaVersion: 1 }),
};

/**
 * The declared format version of a raw object definition. Absent = legacy 0.
 * Throws `schema.version.unsupported` for a malformed or too-new version
 * (fail-closed: a future format must not be silently misread).
 */
export function schemaVersionOf(raw: RawObject, locale?: Locale): number {
  const value = raw.schemaVersion;
  if (value === undefined) return LEGACY_SCHEMA_FORMAT_VERSION;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SchemaError(
      'schema.version.unsupported',
      { version: String(value), supported: SCHEMA_FORMAT_VERSION },
      locale,
    );
  }
  if (value > SCHEMA_FORMAT_VERSION) {
    throw new SchemaError(
      'schema.version.unsupported',
      { version: value, supported: SCHEMA_FORMAT_VERSION },
      locale,
    );
  }
  return value;
}

export interface MigratedSchema {
  /** the definition at the current format version (a new object when migrated) */
  object: RawObject;
  /** the version the input was at (0 for unversioned files) */
  from: number;
  /** true when at least one migration step ran */
  migrated: boolean;
}

/**
 * Bring a raw object definition up to the current on-disk format (pure). The
 * loader applies this on read so old files keep working; `weave schema:upgrade`
 * applies it and writes the result back to disk.
 */
export function migrateSchemaObject(raw: RawObject, locale?: Locale): MigratedSchema {
  let version = schemaVersionOf(raw, locale);
  const from = version;
  let current = raw;
  while (version < SCHEMA_FORMAT_VERSION) {
    const step = MIGRATIONS[version];
    if (step === undefined) {
      throw new SchemaError(
        'schema.version.unsupported',
        { version, supported: SCHEMA_FORMAT_VERSION },
        locale,
      );
    }
    current = step(current);
    version += 1;
  }
  return { object: current, from, migrated: current !== raw };
}
