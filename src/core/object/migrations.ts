import type { Locale } from '../i18n/index.js';
import { DEFAULT_LOCALE } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import { LEGACY_SCHEMA_FORMAT_VERSION, SCHEMA_FORMAT_VERSION } from './schema-version.js';

type RawObject = Record<string, unknown>;

function isRecord(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** fold a legacy scalar `label` into `labels[default locale]` (existing labels win) */
function labelToLabels(raw: RawObject): RawObject {
  if (typeof raw.label !== 'string') return raw;
  const { label, ...rest } = raw;
  const existing = isRecord(raw.labels) ? raw.labels : {};
  return { ...rest, labels: { [DEFAULT_LOCALE]: label, ...existing } };
}

/** v1 → v2: object- and field-level `label` become a per-locale `labels` map */
function migrateLabelsToMap(raw: RawObject): RawObject {
  const migrated = labelToLabels(raw);
  const fields = Array.isArray(migrated.fields)
    ? migrated.fields.map((field) => (isRecord(field) ? labelToLabels(field) : field))
    : migrated.fields;
  return { ...migrated, fields, schemaVersion: 2 };
}

/** v2 → v3: object-level `constraints` (table-level UNIQUE) become available; shape is additive */
function migrateAddConstraintSupport(raw: RawObject): RawObject {
  return { ...raw, schemaVersion: 3 };
}

/**
 * v3 → v4: the `json` field type now maps to PostgreSQL `json`. Previously `json`
 * mapped to `jsonb`, so rewrite existing `json` fields to the explicit `jsonb`
 * type (semantics preserved; `json` is now free to mean PG `json`).
 */
function migrateJsonToJsonb(raw: RawObject): RawObject {
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map((field) =>
        isRecord(field) && field.type === 'json' ? { ...field, type: 'jsonb' } : field,
      )
    : raw.fields;
  return { ...raw, fields, schemaVersion: 4 };
}

/**
 * v4 → v5: the `person` field type is renamed to `user`; the identity FK types
 * (`user`/`department`) now target the engine identity objects
 * (`weavekit_user`/`weavekit_department`) implicitly. Drop a declared `target`
 * on those fields and the legacy `person.department` attr.
 */
function migratePersonToUser(raw: RawObject): RawObject {
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map((field) => {
        if (!isRecord(field)) return field;
        if (field.type !== 'person' && field.type !== 'user' && field.type !== 'department') return field;
        const next: RawObject = { ...field };
        delete next.target;
        if (field.type === 'person') {
          next.type = 'user';
          delete next.department;
        }
        return next;
      })
    : raw.fields;
  return { ...raw, fields, schemaVersion: 5 };
}

/**
 * v5 → v6: named enum declarations (`enums/<name>.json`) become available and a
 * static enum field may reference one by `enumType` with `options` omitted. The
 * change is additive — inline options keep working — so the step only stamps the
 * version.
 */
function migrateAddNamedEnums(raw: RawObject): RawObject {
  return { ...raw, schemaVersion: 6 };
}

/**
 * On-disk format migrations: `from`-version → a transform producing version+1.
 * Append a step here whenever {@link SCHEMA_FORMAT_VERSION} is bumped. Steps
 * must be pure (they may not read files or the database).
 */
const MIGRATIONS: Record<number, (raw: RawObject) => RawObject> = {
  // v0 (unversioned) → v1: make the format version explicit.
  0: (raw) => ({ ...raw, schemaVersion: 1 }),
  // v1 → v2: replace the scalar `label` with the per-locale `labels` map.
  1: migrateLabelsToMap,
  // v2 → v3: stamp the version; `constraints` is optional and needs no rewrite.
  2: migrateAddConstraintSupport,
  // v3 → v4: `json` now maps to PG `json`; rewrite former `json` (== JSONB) to `jsonb`.
  3: migrateJsonToJsonb,
  // v4 → v5: `person` → `user`; identity FK types target the identity objects implicitly.
  4: migratePersonToUser,
  // v5 → v6: named enum declarations (`enums/`) + `enumType`-only references (additive).
  5: migrateAddNamedEnums,
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
