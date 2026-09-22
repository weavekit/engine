import { describe, it, expect } from '../helpers/test.js';
import {
  DEFAULT_LOCALE,
  migrateSchemaObject,
  parseSchema,
  SCHEMA_FORMAT_VERSION,
  schemaVersionOf,
  validateObject,
} from '../../src/core/index.js';

const base = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
  ],
};

describe('schema format version', () => {
  it('validateObject accepts absent (legacy) and the current version', () => {
    expect(validateObject(base).schemaVersion).toBeUndefined();
    expect(validateObject({ ...base, schemaVersion: SCHEMA_FORMAT_VERSION }).schemaVersion).toBe(SCHEMA_FORMAT_VERSION);
  });

  it('validateObject rejects a future version (fail-closed)', () => {
    expect(() => validateObject({ ...base, schemaVersion: SCHEMA_FORMAT_VERSION + 1 })).toThrow(
      /unsupported schema format version/,
    );
  });

  it('validateObject rejects a malformed version', () => {
    expect(() => validateObject({ ...base, schemaVersion: 'one' })).toThrow(
      /unsupported schema format version/,
    );
  });

  it('parseSchema migrates an unversioned file to the current version', () => {
    const parsed = parseSchema(JSON.stringify(base));
    expect(parsed.schemaVersion).toBe(SCHEMA_FORMAT_VERSION);
  });

  it('parseSchema keeps an explicit current version', () => {
    const parsed = parseSchema(JSON.stringify({ ...base, schemaVersion: SCHEMA_FORMAT_VERSION }));
    expect(parsed.schemaVersion).toBe(SCHEMA_FORMAT_VERSION);
  });

  it('parseSchema rejects a future version', () => {
    expect(() => parseSchema(JSON.stringify({ ...base, schemaVersion: 99 }))).toThrow(
      /unsupported schema format version/,
    );
  });

  it('migrateSchemaObject stamps legacy files and is a no-op when current', () => {
    const legacy = migrateSchemaObject({ ...base });
    expect(legacy.from).toBe(0);
    expect(legacy.migrated).toBe(true);
    expect(legacy.object.schemaVersion).toBe(SCHEMA_FORMAT_VERSION);

    const current = migrateSchemaObject({ ...base, schemaVersion: SCHEMA_FORMAT_VERSION });
    expect(current.migrated).toBe(false);
    expect(current.object.schemaVersion).toBe(SCHEMA_FORMAT_VERSION);
  });

  it('migrates legacy object + field label into labels[default locale]', () => {
    const parsed = parseSchema(
      JSON.stringify({
        name: 'lead',
        label: 'Lead',
        fields: [{ name: 'id', type: 'string', primary: true, label: 'ID' }],
      }),
    );
    expect(parsed.schemaVersion).toBe(SCHEMA_FORMAT_VERSION);
    expect(parsed.labels).toEqual({ [DEFAULT_LOCALE]: 'Lead' });
    expect(parsed.fields[0]?.labels).toEqual({ [DEFAULT_LOCALE]: 'ID' });
  });

  it('parseSchema migrates a v2 file to the current version', () => {
    const parsed = parseSchema(JSON.stringify({ ...base, schemaVersion: 2 }));
    expect(parsed.schemaVersion).toBe(SCHEMA_FORMAT_VERSION);
  });

  it('schemaVersionOf reports legacy 0 for unversioned input', () => {
    expect(schemaVersionOf({ ...base })).toBe(0);
  });
});
