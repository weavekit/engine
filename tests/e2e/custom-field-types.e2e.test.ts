import { describe, it, expect } from '../helpers/test.js';
import {
  buildFieldTypeRegistry,
  createDataAccess,
  createPool,
  migrate,
  ObjectRegistry,
  SchemaError,
} from '../../src/index.js';
import type { DataAccessContext } from '../../src/runtime/data-access/index.js';

/**
 * End-to-end coverage for registered-type storage/validation hooks and
 * object-level constraints against a real PostgreSQL instance. Skips when
 * DATABASE_URL is unset (same convention as the other e2e suites).
 */

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const fieldTypes = buildFieldTypeRegistry([
  {
    name: 'acme_money',
    base: 'number',
    attrs: { scale: { type: 'integer' } },
    storage: { pgType: (f) => `NUMERIC(12,${(f as { scale?: number }).scale ?? 2})` },
  },
  {
    name: 'acme_even',
    base: 'integer',
    validate: (_f, v) => (typeof v === 'number' && v % 2 !== 0 ? 'must be even' : undefined),
  },
  { name: 'acme_currency', base: 'string', references: { object: 'currency', column: 'code' } },
]);

const CURRENCY = {
  name: 'currency',
  fields: [{ name: 'code', type: 'string', primary: true }],
};

const INVOICE = {
  name: 'invoice',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'code', type: 'string' },
    { name: 'tenant_id', type: 'string' },
    { name: 'amount', type: 'acme_money', scale: 2 },
    { name: 'even', type: 'acme_even' },
    { name: 'ccy', type: 'acme_currency' },
  ],
  constraints: [{ type: 'unique', fields: ['code', 'tenant_id'] }],
};

maybe('custom field types + constraints (real PG)', () => {
  it('migrates custom storage + composite UNIQUE, and enforces hooks at write time', async () => {
    const setup = createPool(url!);
    const registry = new ObjectRegistry({ fieldTypes });
    registry.register(CURRENCY, { fieldTypes });
    registry.register(INVOICE, { fieldTypes });
    registry.buildGraph();

    const dataAccess = createDataAccess();
    const ctx: DataAccessContext = { pool: setup, registry, locale: 'en' };

    try {
      await setup.query('DROP TABLE IF EXISTS invoice, currency CASCADE');
      await migrate(registry, { databaseUrl: url! });

      // custom storage.pgType reached the DDL (NUMERIC(12,2))
      const col = await setup.query(
        `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
          WHERE table_name = 'invoice' AND column_name = 'amount'`,
      );
      expect(col.rows[0]).toMatchObject({ data_type: 'numeric', numeric_precision: 12, numeric_scale: 2 });

      // composite UNIQUE constraint exists
      const cons = await setup.query(
        `SELECT constraint_name, constraint_type FROM information_schema.table_constraints
          WHERE table_name = 'invoice' AND constraint_type = 'UNIQUE'`,
      );
      expect(cons.rows.map((r: { constraint_name: string }) => r.constraint_name)).toContain(
        'invoice_code_tenant_id_key',
      );

      // seed the referenced currency
      await dataAccess.create('currency', { code: 'USD' }, ctx);

      // a legal write passes (base-inherited + custom hooks all satisfied)
      const ok = await dataAccess.create(
        'invoice',
        { id: 'I1', code: 'A', tenant_id: 'T1', amount: 10.5, even: 2, ccy: 'USD' },
        ctx,
      );
      expect((ok as { id: string }).id).toBe('I1');

      const expectCode = async (data: Record<string, unknown>): Promise<string | undefined> => {
        try {
          await dataAccess.create('invoice', data, ctx);
          return undefined;
        } catch (error) {
          return error instanceof SchemaError ? error.code : undefined;
        }
      };

      // composite unique violation → data.unique (409 at the API layer)
      expect(await expectCode({ id: 'I2', code: 'A', tenant_id: 'T1', amount: 1, even: 4, ccy: 'USD' })).toBe('data.unique');
      // references membership → data.field.references
      expect(await expectCode({ id: 'I3', code: 'B', tenant_id: 'T1', amount: 1, even: 4, ccy: 'ZZZ' })).toBe(
        'data.field.references',
      );
      // custom validate hook → data.field.custom
      expect(await expectCode({ id: 'I4', code: 'C', tenant_id: 'T1', amount: 1, even: 3, ccy: 'USD' })).toBe(
        'data.field.custom',
      );
      // base primitive value validation is inherited → data.field.type (number)
      expect(await expectCode({ id: 'I5', code: 'D', tenant_id: 'T1', amount: 'nope', even: 2, ccy: 'USD' })).toBe(
        'data.field.type',
      );
    } finally {
      await setup.query('DROP TABLE IF EXISTS invoice, currency CASCADE').catch(() => undefined);
      await setup.end();
    }
  }, 60000);
});
