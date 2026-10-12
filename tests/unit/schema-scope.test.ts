import { describe, it, expect } from '../helpers/test.js';
import {
  DEFAULT_SCHEMA_SCOPE,
  assertSchemaName,
  buildSystemTables,
  createSchemaScope,
  qualifyTable,
} from '../../src/core/index.js';

describe('schema-scope — explicit system-schema qualification', () => {
  it('no system schema → default scope, bare quoted identifiers', () => {
    expect(createSchemaScope(undefined)).toBe(DEFAULT_SCHEMA_SCOPE);
    expect(qualifyTable('weavekit_meta')).toBe('"weavekit_meta"');
    expect(qualifyTable('weavekit_meta', DEFAULT_SCHEMA_SCOPE)).toBe('"weavekit_meta"');
  });

  it('system schema → qualified identifiers', () => {
    const scope = createSchemaScope('weavekit');
    expect(scope.systemSchema).toBe('weavekit');
    expect(qualifyTable('weavekit_meta', scope)).toBe('"weavekit"."weavekit_meta"');
  });

  it('buildSystemTables(scope) tags every system table with the schema', () => {
    const scope = createSchemaScope('weavekit');
    for (const t of buildSystemTables(scope)) {
      expect(t.schema).toBe('weavekit');
    }
    for (const t of buildSystemTables()) {
      expect(t.schema).toBeUndefined();
    }
  });

  it('assertSchemaName rejects unsafe identifiers', () => {
    expect(() => assertSchemaName('weavekit')).not.toThrow();
    expect(() => assertSchemaName('WeaveKit')).toThrow();
    expect(() => assertSchemaName('1schema')).toThrow();
    expect(() => assertSchemaName('a;drop table x')).toThrow();
    expect(() => createSchemaScope('bad-name')).toThrow();
  });
});
