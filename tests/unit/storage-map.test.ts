import { describe, it, expect } from '../helpers/test.js';import { defaultExpr, pgType } from '../../src/core/index.js';
import { pgTypeMatches } from '../../src/core/storage/map.js';
import type { FieldDefinition } from '../../src/core/index.js';

const f = (def: FieldDefinition) => def;

describe('pgType — type mapping', () => {
  it('scalar types', () => {
    expect(pgType(f({ name: 'a', type: 'string' }), undefined)).toBe('VARCHAR(255)');
    expect(pgType(f({ name: 'a', type: 'text' }), undefined)).toBe('TEXT');
    expect(pgType(f({ name: 'a', type: 'integer' }), undefined)).toBe('INTEGER');
    expect(pgType(f({ name: 'a', type: 'currency' }), undefined)).toBe('NUMERIC(12,2)');
    expect(pgType(f({ name: 'a', type: 'boolean' }), undefined)).toBe('BOOLEAN');
    expect(pgType(f({ name: 'a', type: 'timestamptz' }), undefined)).toBe('TIMESTAMPTZ');
    expect(pgType(f({ name: 'a', type: 'timestamp' }), undefined)).toBe('TIMESTAMP');
    expect(pgType(f({ name: 'a', type: 'date' }), undefined)).toBe('DATE');
    expect(pgType(f({ name: 'a', type: 'time' }), undefined)).toBe('TIME');
    expect(pgType(f({ name: 'a', type: 'timetz' }), undefined)).toBe('TIMETZ');
    expect(pgType(f({ name: 'a', type: 'interval' }), undefined)).toBe('INTERVAL');
    expect(pgType(f({ name: 'a', type: 'uuid' }), undefined)).toBe('UUID');
    expect(pgType(f({ name: 'a', type: 'json' }), undefined)).toBe('JSON');
    expect(pgType(f({ name: 'a', type: 'jsonb' }), undefined)).toBe('JSONB');
    expect(pgType(f({ name: 'a', type: 'number' }), undefined)).toBe('NUMERIC');
    expect(pgType(f({ name: 'a', type: 'number', precision: 10 }), undefined)).toBe('NUMERIC(10)');
    expect(pgType(f({ name: 'a', type: 'number', precision: 12, scale: 2 }), undefined)).toBe('NUMERIC(12,2)');
    expect(pgType(f({ name: 'a', type: 'smallint' }), undefined)).toBe('SMALLINT');
    expect(pgType(f({ name: 'a', type: 'bigint' }), undefined)).toBe('BIGINT');
    expect(pgType(f({ name: 'a', type: 'real' }), undefined)).toBe('REAL');
    expect(pgType(f({ name: 'a', type: 'double' }), undefined)).toBe('DOUBLE PRECISION');
    expect(pgType(f({ name: 'a', type: 'char' }), undefined)).toBe('CHAR(1)');
    expect(pgType(f({ name: 'a', type: 'char', length: 5 }), undefined)).toBe('CHAR(5)');
  });

  it('currency scale follows the ISO code; precision is configurable', () => {
    expect(pgType(f({ name: 'a', type: 'currency' }), undefined)).toBe('NUMERIC(12,2)');
    expect(pgType(f({ name: 'a', type: 'currency', currency: 'USD' }), undefined)).toBe('NUMERIC(12,2)');
    expect(pgType(f({ name: 'a', type: 'currency', currency: 'JPY' }), undefined)).toBe('NUMERIC(12,0)');
    expect(pgType(f({ name: 'a', type: 'currency', precision: 18 }), undefined)).toBe('NUMERIC(18,2)');
    expect(pgType(f({ name: 'a', type: 'currency', currency: 'JPY', precision: 20 }), undefined)).toBe('NUMERIC(20,0)');
  });

  it('enum single vs multiple', () => {
    expect(pgType(f({ name: 'a', type: 'enum', options: ['x'] }), undefined)).toBe('VARCHAR(255)');
    expect(pgType(f({ name: 'a', type: 'enum', options: ['x'], multiple: true }), undefined)).toBe('TEXT[]');
  });

  it('enum with a native PG type name', () => {
    expect(pgType(f({ name: 'a', type: 'enum', options: ['x'], enumType: 'lead_status' }), undefined)).toBe('lead_status');
    expect(
      pgType(f({ name: 'a', type: 'enum', options: ['x'], enumType: 'lead_status', multiple: true }), undefined),
    ).toBe('lead_status[]');
  });

  it('relation uses target primary key type', () => {
    expect(pgType(f({ name: 'oid', type: 'relation', target: 'order' }), 'INTEGER')).toBe('INTEGER');
    expect(pgType(f({ name: 'oid', type: 'relation', target: 'order' }), undefined)).toBe('VARCHAR(255)');
  });

  it('string subtypes + image + identity FK', () => {
    expect(pgType(f({ name: 'fn', type: 'firstName' }), undefined)).toBe('VARCHAR(255)');
    expect(pgType(f({ name: 'ln', type: 'lastName' }), undefined)).toBe('VARCHAR(255)');
    expect(pgType(f({ name: 'em', type: 'email' }), undefined)).toBe('VARCHAR(255)');
    expect(pgType(f({ name: 'ph', type: 'phone' }), undefined)).toBe('VARCHAR(255)');
    expect(pgType(f({ name: 'img', type: 'image' }), undefined)).toBe('VARCHAR(255)');
    expect(pgType(f({ name: 'img', type: 'image', multiple: true }), undefined)).toBe('TEXT[]');
    expect(pgType(f({ name: 'owner', type: 'user', target: 'weavekit_user' }), 'INTEGER')).toBe('INTEGER');
    expect(pgType(f({ name: 'dept', type: 'department', target: 'weavekit_department' }), undefined)).toBe('VARCHAR(255)');
  });

  it('multiRelation has no column (link table); seq_no maps to VARCHAR', () => {
    let threw = false;
    try {
      pgType(f({ name: 'c', type: 'multiRelation', target: 'contact' }), undefined);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(pgType(f({ name: 'no', type: 'seq_no', format: '{seq}' }), undefined)).toBe('VARCHAR(255)');
  });
});

describe('defaultExpr — default value mapping', () => {
  it('timestamptz now → now()', () => {
    expect(defaultExpr(f({ name: 'c', type: 'timestamptz', default: 'now' }))).toBe('now()');
  });
  it('string/boolean/integer', () => {
    expect(defaultExpr(f({ name: 's', type: 'string', default: 'abc' }))).toBe("'abc'");
    expect(defaultExpr(f({ name: 'b', type: 'boolean', default: true }))).toBe('true');
    expect(defaultExpr(f({ name: 'n', type: 'integer', default: 5 }))).toBe('5');
  });
  it('string subtypes + image', () => {
    expect(defaultExpr(f({ name: 'em', type: 'email', default: 'a@b.c' }))).toBe("'a@b.c'");
    expect(defaultExpr(f({ name: 'img', type: 'image', default: 'u' }))).toBe("'u'");
    expect(defaultExpr(f({ name: 'img', type: 'image', multiple: true, default: ['u'] }))).toBeUndefined();
  });
  it('enum multiple has no DDL default', () => {
    expect(defaultExpr(f({ name: 'e', type: 'enum', options: ['a'], multiple: true, default: ['a'] }))).toBeUndefined();
  });
  it('no default returns undefined', () => {
    expect(defaultExpr(f({ name: 'a', type: 'string' }))).toBeUndefined();
  });
});

describe('defaultExpr — DDL literal escaping', () => {
  it('escapes single quotes in string defaults', () => {
    expect(defaultExpr(f({ name: 's', type: 'string', default: "O'Brien" }))).toBe("'O''Brien'");
    expect(defaultExpr(f({ name: 's', type: 'string', default: "x'; DROP TABLE t; --" }))).toBe(
      "'x''; DROP TABLE t; --'",
    );
  });
  it('escapes date/uuid/char/enum defaults', () => {
    expect(defaultExpr(f({ name: 'd', type: 'date', default: "2020-01-01'" }))).toBe("'2020-01-01'''");
    expect(defaultExpr(f({ name: 'u', type: 'uuid', default: "a'" }))).toBe("'a'''");
    expect(defaultExpr(f({ name: 'c', type: 'char', default: "a'" }))).toBe("'a'''");
    expect(defaultExpr(f({ name: 'e', type: 'enum', options: ["a'b"], default: "a'b" }))).toBe("'a''b'");
  });
  it('bigint: integer string emitted raw; non-integer fails loud', () => {
    expect(defaultExpr(f({ name: 'n', type: 'bigint', default: '9007199254740993' }))).toBe('9007199254740993');
    let caught: unknown;
    try {
      defaultExpr(f({ name: 'n', type: 'bigint', default: '1; DROP TABLE x' }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('storage.default.invalid');
  });
});

describe('pgTypeMatches — custom-storage vocabulary (no false drift)', () => {
  const col = (dataType: string, extra: Record<string, unknown> = {}) => ({ dataType, ...extra });

  it('covers the types isSafePgType allows', () => {
    expect(pgTypeMatches('UUID', col('uuid'))).toBe(true);
    expect(pgTypeMatches('BIGINT', col('bigint'))).toBe(true);
    expect(pgTypeMatches('SMALLINT', col('smallint'))).toBe(true);
    expect(pgTypeMatches('REAL', col('real'))).toBe(true);
    expect(pgTypeMatches('DOUBLE PRECISION', col('double precision'))).toBe(true);
    expect(pgTypeMatches('JSON', col('json'))).toBe(true);
    expect(pgTypeMatches('MONEY', col('money'))).toBe(true);
    expect(pgTypeMatches('TIME', col('time without time zone'))).toBe(true);
    expect(pgTypeMatches('TIMESTAMP', col('timestamp without time zone'))).toBe(true);
    expect(pgTypeMatches('TIMESTAMP WITH TIME ZONE', col('timestamp with time zone'))).toBe(true);
    expect(pgTypeMatches('CHARACTER VARYING', col('character varying'))).toBe(true);
    expect(pgTypeMatches('BPCHAR', col('bpchar'))).toBe(true);
  });

  it('handles array suffixes for the broader vocabulary', () => {
    expect(pgTypeMatches('UUID[]', col('ARRAY', { udtName: '_uuid' }))).toBe(true);
    expect(pgTypeMatches('BIGINT[]', col('ARRAY', { udtName: '_int8' }))).toBe(true);
    expect(pgTypeMatches('NUMERIC[]', col('ARRAY', { udtName: '_numeric' }))).toBe(true);
    expect(pgTypeMatches('UUID[]', col('ARRAY', { udtName: '_text' }))).toBe(false);
  });

  it('still rejects a genuine mismatch', () => {
    expect(pgTypeMatches('UUID', col('text'))).toBe(false);
    expect(pgTypeMatches('NUMERIC(12,2)', col('numeric', { numericPrecision: 10, numericScale: 2 }))).toBe(false);
    expect(pgTypeMatches('NUMERIC(12,2)', col('numeric', { numericPrecision: 12, numericScale: 2 }))).toBe(true);
  });

  it('matches a native enum type by its udt_name', () => {
    expect(pgTypeMatches('lead_status', col('USER-DEFINED', { udtName: 'lead_status' }))).toBe(true);
    expect(pgTypeMatches('lead_status', col('USER-DEFINED', { udtName: 'other_status' }))).toBe(false);
    expect(pgTypeMatches('lead_tags[]', col('ARRAY', { udtName: '_lead_tags' }))).toBe(true);
  });
});
