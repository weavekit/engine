import { describe, it, expect } from '../helpers/test.js';
import { createPool, inspectSchema, mapToSchema, migrate, ObjectRegistry } from '../../src/core/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Scalar type fidelity E2E (local PG)', () => {
  it('round-trips smallint/bigint/real/double/char/numeric(p,s)', async () => {
    const object = 'wk_scalar_types';
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS "${object}", "weavekit_record__${object}" CASCADE`);

      const reg = new ObjectRegistry();
      reg.register({
        name: object,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 's', type: 'smallint' },
          { name: 'b', type: 'bigint' },
          { name: 'r', type: 'real' },
          { name: 'd', type: 'double' },
          { name: 'c', type: 'char', length: 5 },
          { name: 'n', type: 'number', precision: 12, scale: 2 },
          { name: 'j', type: 'json' },
          { name: 'jb', type: 'jsonb' },
        ],
      });
      await migrate(reg, { databaseUrl: url! });

      const actual = await inspectSchema(pool);
      const cols = new Map(actual.get(object)!.columns.map((c) => [c.name, c]));
      expect(cols.get('s')?.dataType).toBe('smallint');
      expect(cols.get('b')?.dataType).toBe('bigint');
      expect(cols.get('r')?.dataType).toBe('real');
      expect(cols.get('d')?.dataType).toBe('double precision');
      expect(cols.get('c')?.dataType).toBe('character');
      expect(cols.get('c')?.characterMaximumLength).toBe(5);
      expect(cols.get('n')?.numericPrecision).toBe(12);
      expect(cols.get('n')?.numericScale).toBe(2);
      expect(cols.get('j')?.dataType).toBe('json');
      expect(cols.get('jb')?.dataType).toBe('jsonb');

      // reverse-modeling recovers the exact engine types (round-trip closed)
      const report = mapToSchema(actual, { include: [object] });
      const fields = new Map(report.objects[0]!.schema.fields.map((f) => [f.name, f]));
      expect(fields.get('s')?.type).toBe('smallint');
      expect(fields.get('b')?.type).toBe('bigint');
      expect(fields.get('r')?.type).toBe('real');
      expect(fields.get('d')?.type).toBe('double');
      expect(fields.get('c')?.type).toBe('char');
      expect((fields.get('c') as { length?: number }).length).toBe(5);
      expect(fields.get('n')?.type).toBe('number');
      expect((fields.get('n') as { precision?: number }).precision).toBe(12);
      expect((fields.get('n') as { scale?: number }).scale).toBe(2);
      expect(fields.get('j')?.type).toBe('json');
      expect(fields.get('jb')?.type).toBe('jsonb');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${object}", "weavekit_record__${object}" CASCADE`);
      await pool.end();
    }
  });
});
