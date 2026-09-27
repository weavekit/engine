import { describe, it, expect } from '../helpers/test.js';
import { createPool, inspectSchema, mapToSchema } from '../../src/core/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const CUSTOMER = 'wk_introspect_e2e_customer';
const ORDER = 'wk_introspect_e2e_order';
const STATUS = 'wk_introspect_e2e_status';

maybe('introspect E2E (real PG)', () => {
  it('reverse-models a live schema (enum/FK on-delete/unique/comment/precision)', async () => {
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS ${ORDER} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${CUSTOMER} CASCADE`);
      await pool.query(`DROP TYPE IF EXISTS ${STATUS} CASCADE`);

      await pool.query(`CREATE TABLE ${CUSTOMER} (
        id uuid PRIMARY KEY,
        email varchar(255) UNIQUE NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await pool.query(`COMMENT ON TABLE ${CUSTOMER} IS 'Customer'`);
      await pool.query(`COMMENT ON COLUMN ${CUSTOMER}.email IS 'Email'`);

      await pool.query(`CREATE TYPE ${STATUS} AS ENUM ('open', 'closed')`);
      await pool.query(`CREATE TABLE ${ORDER} (
        id integer PRIMARY KEY,
        customer_id uuid NOT NULL REFERENCES ${CUSTOMER}(id) ON DELETE CASCADE,
        status ${STATUS} NOT NULL DEFAULT 'open',
        total numeric(12,2) DEFAULT 0
      )`);

      const actual = await inspectSchema(pool, { detail: true });
      const report = mapToSchema(actual, { include: [CUSTOMER, ORDER] });

      expect(report.objects.map((o) => o.name)).toEqual([CUSTOMER, ORDER]);

      const customer = report.objects.find((o) => o.name === CUSTOMER)!;
      expect(customer.schema.labels?.en).toBe('Customer');
      expect(customer.schema.alter).toBe(false);
      const email = customer.schema.fields.find((f) => f.name === 'email') as unknown as {
        unique?: boolean;
        required?: boolean;
        labels?: Record<string, string>;
      };
      expect(email.unique).toBe(true);
      expect(email.required).toBe(true);
      expect(email.labels?.en).toBe('Email');
      const createdAt = customer.schema.fields.find((f) => f.name === 'created_at') as unknown as { default?: string };
      expect(createdAt.default).toBe('now');

      const order = report.objects.find((o) => o.name === ORDER)!;
      const rel = order.schema.fields.find((f) => f.name === 'customer_id') as unknown as {
        type: string;
        target: string;
        onDelete?: string;
        required?: boolean;
      };
      expect(rel.type).toBe('relation');
      expect(rel.target).toBe(CUSTOMER);
      expect(rel.onDelete).toBe('cascade');
      expect(rel.required).toBe(true);
      const status = order.schema.fields.find((f) => f.name === 'status') as unknown as {
        type: string;
        options?: string[];
        default?: string;
      };
      expect(status.type).toBe('enum');
      expect(status.options).toEqual(['open', 'closed']);
      expect(status.default).toBe('open');
      const total = order.schema.fields.find((f) => f.name === 'total') as unknown as { default?: number; precision?: number };
      expect(total.default).toBe(0);
      expect(total.precision).toBe(12);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${ORDER} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${CUSTOMER} CASCADE`);
      await pool.query(`DROP TYPE IF EXISTS ${STATUS} CASCADE`);
      await pool.end();
    }
  });

  it('reverse-models a composite primary key in live key order', async () => {
    const LINE = 'wk_introspect_e2e_line';
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS ${LINE} CASCADE`);
      await pool.query(`CREATE TABLE ${LINE} (
        qty integer,
        line_no integer,
        order_id integer,
        PRIMARY KEY (order_id, line_no)
      )`);

      const report = mapToSchema(await inspectSchema(pool, { detail: true }), { include: [LINE] });
      expect(report.skipped).toHaveLength(0);
      const obj = report.objects.find((o) => o.name === LINE)!;
      expect(obj.schema.fields.filter((f) => f.primary === true).map((f) => f.name)).toEqual(['order_id', 'line_no']);
      expect(obj.schema.fields.find((f) => f.name === 'qty')?.primary).toBeUndefined();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${LINE} CASCADE`);
      await pool.end();
    }
  });
});
