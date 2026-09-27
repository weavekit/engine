import { describe, it, expect } from '../helpers/test.js';
import { pkValueTextSql, recordKeySql } from '../../src/core/storage/record-key-sql.js';
import { defineObject } from '../../src/core/index.js';
import type { FieldDefinition } from '../../src/core/index.js';

const f = (type: string): FieldDefinition => ({ name: 'x', type }) as unknown as FieldDefinition;

describe('pkValueTextSql — canonical text SQL per type', () => {
  it('scalar types cast to text', () => {
    for (const type of ['string', 'text', 'integer', 'number', 'currency', 'boolean', 'enum']) {
      expect(pkValueTextSql(f(type), 'c')).toBe('c::text');
    }
  });

  it('uuid is lowercased', () => {
    expect(pkValueTextSql(f('uuid'), 'c')).toBe('lower(c::text)');
  });

  it('date uses a fixed date format', () => {
    expect(pkValueTextSql(f('date'), 'c')).toContain("to_char(c, 'YYYY-MM-DD')");
  });

  it('time/timestamp/timestamptz use to_char', () => {
    expect(pkValueTextSql(f('time'), 'c')).toContain('HH24:MI:SS.US');
    expect(pkValueTextSql(f('timestamp'), 'c')).toContain('HH24:MI:SS.US');
    const tz = pkValueTextSql(f('timestamptz'), 'c');
    expect(tz).toContain("AT TIME ZONE 'UTC'");
    expect(tz).toContain("|| 'Z'");
  });
});

describe('recordKeySql — length-prefixed concatenation', () => {
  it('single primary field', () => {
    const def = defineObject({ name: 'a', fields: [{ name: 'id', type: 'string', primary: true }] });
    const sql = recordKeySql(def, (n) => `"${n}"`);
    expect(sql).toContain('octet_length(');
    expect(sql).toContain("':'");
    expect(sql).toContain('"id"::text');
  });

  it('composite joins every primary field', () => {
    const def = defineObject({
      name: 'b',
      fields: [
        { name: 'a', type: 'string', primary: true },
        { name: 'b', type: 'integer', primary: true },
      ],
    });
    const sql = recordKeySql(def, (n) => `"${n}"`);
    expect(sql).toContain('"a"::text');
    expect(sql).toContain('"b"::text');
    expect(sql.match(/octet_length\(/g)?.length).toBe(2);
  });
});
