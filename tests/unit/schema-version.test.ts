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

  it('migrates a v3 `json` field to `jsonb` (json now means PG json)', () => {
    const migrated = migrateSchemaObject({
      name: 'lead',
      schemaVersion: 3,
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'meta', type: 'json' },
      ],
    });
    expect(migrated.object.schemaVersion).toBe(SCHEMA_FORMAT_VERSION);
    const fields = migrated.object.fields as Array<{ name: string; type: string }>;
    expect(fields.find((f) => f.name === 'meta')?.type).toBe('jsonb');
  });

  it('keeps an explicit v4 `json` field as json', () => {
    const parsed = parseSchema(
      JSON.stringify({
        ...base,
        schemaVersion: SCHEMA_FORMAT_VERSION,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'meta', type: 'json' },
        ],
      }),
    );
    expect(parsed.fields.find((f) => f.name === 'meta')?.type).toBe('json');
  });

  it('migrates a v4 `person` field to `user` and drops identity targets', () => {
    const migrated = migrateSchemaObject({
      name: 'employee',
      schemaVersion: 4,
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'manager_id', type: 'person', target: 'employee', department: 'dept_id' },
        { name: 'dept_id', type: 'department', target: 'department' },
      ],
    });
    expect(migrated.object.schemaVersion).toBe(SCHEMA_FORMAT_VERSION);
    const fields = migrated.object.fields as Array<Record<string, unknown>>;
    const manager = fields.find((f) => f.name === 'manager_id');
    expect(manager).toMatchObject({ type: 'user' });
    expect(manager?.target).toBeUndefined();
    expect(manager?.department).toBeUndefined();
    const dept = fields.find((f) => f.name === 'dept_id');
    expect(dept).toMatchObject({ type: 'department' });
    expect(dept?.target).toBeUndefined();
  });

  it('parseSchema validates a migrated `user` field with the injected identity target', () => {
    const parsed = parseSchema(
      JSON.stringify({
        name: 'employee',
        schemaVersion: 4,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'manager_id', type: 'person', target: 'employee' },
        ],
      }),
    );
    expect(parsed.fields.find((f) => f.name === 'manager_id')).toMatchObject({ type: 'user', target: 'weavekit_user' });
  });
});
