import { describe, it, expect } from '../helpers/test.js';
import { createPool, inspectSchema, mapToSchema, migrate, ObjectRegistry } from '../../src/core/index.js';
import { createDataAccess } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Native enum E2E (local PG)', () => {
  it('creates a native type, filters, and reverse-models it', async () => {
    const object = 'wk_enum';
    const statusType = 'wk_enum_status';
    const tagsType = 'wk_enum_tags';
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS "${object}", "weavekit_record__${object}" CASCADE`);
      await pool.query(`DROP TYPE IF EXISTS "${statusType}", "${tagsType}" CASCADE`);

      const reg = new ObjectRegistry();
      reg.register({
        name: object,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'status', type: 'enum', options: ['open', 'closed'], default: 'open' },
          { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true },
        ],
      });
      await migrate(reg, { databaseUrl: url! });

      // the live columns use the native enum type
      const cols = await pool.query(
        `SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = $1`,
        [object],
      );
      const byName = new Map(
        (cols.rows as { column_name: string; udt_name: string }[]).map((r) => [r.column_name, r.udt_name]),
      );
      expect(byName.get('status')).toBe(statusType);
      expect(byName.get('tags')).toBe(`_${tagsType}`);

      const dataAccess = createDataAccess();
      const ctx = { pool, registry: reg };
      await dataAccess.create(object, { id: 'A1', status: 'closed', tags: ['a', 'b'] }, ctx);
      expect((await dataAccess.find(object, { filter: { status: 'open' } }, ctx)).total).toBe(0);
      expect((await dataAccess.find(object, { filter: { status: 'closed' } }, ctx)).total).toBe(1);
      // enum-array `contains` works (the filter casts the column to text[])
      expect((await dataAccess.find(object, { filter: { tags: { contains: ['a'] } } }, ctx)).total).toBe(1);

      // reverse-modeling recovers the enum + its native type name
      const actual = await inspectSchema(pool, { detail: true });
      const report = mapToSchema(actual, { include: [object] });
      const fields = new Map(report.objects[0]!.schema.fields.map((f) => [f.name, f]));
      const st = fields.get('status') as { type: string; enumType?: string; options?: string[] };
      expect(st.type).toBe('enum');
      expect(st.enumType).toBe(statusType);
      expect(st.options).toEqual(['open', 'closed']);

      const tg = fields.get('tags') as { type: string; multiple?: boolean; enumType?: string; options?: string[] };
      expect(tg.type).toBe('enum');
      expect(tg.multiple).toBe(true);
      expect(tg.enumType).toBe(tagsType);
      expect(tg.options).toEqual(['a', 'b']);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${object}", "weavekit_record__${object}" CASCADE`);
      await pool.query(`DROP TYPE IF EXISTS "${statusType}", "${tagsType}" CASCADE`);
      await pool.end();
    }
  });
});
