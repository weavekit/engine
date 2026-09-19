import { describe, it, expect } from '../helpers/test.js';
import { mapToSchema } from '../../src/core/index.js';
import type { ActualTable } from '../../src/core/index.js';

function table(partial: Partial<ActualTable> & { name: string }): ActualTable {
  return { columns: [], pk: [], fks: [], indexNames: [], ...partial };
}

describe('mapToSchema — DB reverse modeling', () => {
  it('maps tables/columns/PK/FK/enum/unique/default/comment', () => {
    const tables = new Map<string, ActualTable>([
      [
        'customers',
        table({
          name: 'customers',
          comment: 'Customers',
          pk: ['id'],
          uniqueColumns: ['email'],
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false, columnDefault: 'gen_random_uuid()', udtName: 'uuid' },
            {
              name: 'first_name',
              dataType: 'character varying',
              isNullable: false,
              columnDefault: null,
              udtName: 'varchar',
              comment: 'First name',
            },
            { name: 'email', dataType: 'character varying', isNullable: true, columnDefault: null, udtName: 'varchar' },
            {
              name: 'created_at',
              dataType: 'timestamp with time zone',
              isNullable: false,
              columnDefault: 'now()',
              udtName: 'timestamptz',
            },
          ],
        }),
      ],
      [
        'orders',
        table({
          name: 'orders',
          pk: ['id'],
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, columnDefault: "nextval('orders_id_seq'::regclass)", udtName: 'int4' },
            { name: 'customer_id', dataType: 'uuid', isNullable: false, columnDefault: null, udtName: 'uuid' },
            {
              name: 'status',
              dataType: 'USER-DEFINED',
              isNullable: false,
              columnDefault: "'open'::order_status",
              udtName: 'order_status',
              enumLabels: ['open', 'closed'],
            },
            {
              name: 'total',
              dataType: 'numeric',
              isNullable: true,
              columnDefault: '0',
              udtName: 'numeric',
              numericPrecision: 12,
              numericScale: 2,
            },
          ],
          fks: [{ column: 'customer_id', refTable: 'customers', refColumn: 'id', onDelete: 'cascade' }],
        }),
      ],
      [
        'bad_composite',
        table({
          name: 'bad_composite',
          pk: ['a', 'b'],
          columns: [
            { name: 'a', dataType: 'integer', isNullable: false, columnDefault: null },
            { name: 'b', dataType: 'integer', isNullable: false, columnDefault: null },
          ],
        }),
      ],
    ]);

    const report = mapToSchema(tables);
    expect(report.objects.map((o) => o.name)).toEqual(['customers', 'orders']);
    expect(report.skipped.map((s) => s.table)).toContain('bad_composite');

    const orders = report.objects.find((o) => o.name === 'orders')!;
    const rel = orders.schema.fields.find((f) => f.name === 'customer_id') as unknown as {
      type: string;
      target: string;
      onDelete?: string;
      required?: boolean;
    };
    expect(rel.type).toBe('relation');
    expect(rel.target).toBe('customers');
    expect(rel.onDelete).toBe('cascade');
    expect(rel.required).toBe(true);

    const status = orders.schema.fields.find((f) => f.name === 'status') as unknown as {
      type: string;
      options?: string[];
      default?: string;
    };
    expect(status.type).toBe('enum');
    expect(status.options).toEqual(['open', 'closed']);
    expect(status.default).toBe('open');

    const total = orders.schema.fields.find((f) => f.name === 'total') as unknown as { default?: number; precision?: number };
    expect(total.default).toBe(0);
    expect(total.precision).toBe(12);

    const id = orders.schema.fields.find((f) => f.name === 'id') as unknown as { primary?: boolean };
    expect(id.primary).toBe(true);

    const customers = report.objects.find((o) => o.name === 'customers')!;
    expect(customers.schema.name).toBe('customers');
    expect(customers.schema.alter).toBe(false);
    const email = customers.schema.fields.find((f) => f.name === 'email') as unknown as { unique?: boolean };
    expect(email.unique).toBe(true);
    const createdAt = customers.schema.fields.find((f) => f.name === 'created_at') as unknown as { default?: string };
    expect(createdAt.default).toBe('now');
    const firstName = customers.schema.fields.find((f) => f.name === 'first_name') as unknown as { label?: string; required?: boolean };
    expect(firstName.label).toBe('First name');
    expect(firstName.required).toBe(true);
  });

  it('honors include/exclude filters', () => {
    const tables = new Map<string, ActualTable>([
      ['a', table({ name: 'a', pk: ['id'], columns: [{ name: 'id', dataType: 'integer', isNullable: false, columnDefault: null }] })],
      ['b', table({ name: 'b', pk: ['id'], columns: [{ name: 'id', dataType: 'integer', isNullable: false, columnDefault: null }] })],
    ]);
    expect(mapToSchema(tables, { include: ['a'] }).objects.map((o) => o.name)).toEqual(['a']);
    expect(mapToSchema(tables, { exclude: ['a'] }).objects.map((o) => o.name)).toEqual(['b']);
  });

  it('warns on unsupported column types/defaults and skips those columns', () => {
    const tables = new Map<string, ActualTable>([
      [
        't',
        table({
          name: 't',
          pk: ['id'],
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, columnDefault: null },
            { name: 'tags', dataType: 'ARRAY', isNullable: true, columnDefault: null, udtName: '_text' },
            { name: 'weird', dataType: 'integer', isNullable: true, columnDefault: 'gen_random_uuid()', udtName: 'int4' },
          ],
        }),
      ],
    ]);
    const report = mapToSchema(tables);
    expect(report.warnings.some((w) => w.includes('array type'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('not representable'))).toBe(true);
    const t = report.objects.find((o) => o.name === 't')!;
    expect(t.schema.fields.map((f) => f.name)).not.toContain('tags');
  });

  it('reports (does not silently drop) tables without a single primary key', () => {
    const report = mapToSchema(
      new Map<string, ActualTable>([
        ['no_pk', table({ name: 'no_pk', pk: [], columns: [{ name: 'x', dataType: 'integer', isNullable: true, columnDefault: null }] })],
      ]),
    );
    expect(report.objects).toHaveLength(0);
    expect(report.skipped[0]?.reason).toContain('primary key');
  });
});
