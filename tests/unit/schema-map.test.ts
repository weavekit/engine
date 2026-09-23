import { describe, it, expect } from '../helpers/test.js';
import { parseSchema, pgTypeMatches, buildMappingReport } from '../../src/core/index.js';
import type { ActualTable, ObjectDefinition } from '../../src/core/index.js';

function table(partial: Partial<ActualTable> & { name: string }): ActualTable {
  return { columns: [], pk: [], fks: [], indexNames: [], ...partial };
}

function obj(name: string, fields: unknown[]): ObjectDefinition {
  return parseSchema(JSON.stringify({ name, fields }), { nameHint: name });
}

const ID = { name: 'id', type: 'string', primary: true };

/** a live column matching the engine's declared mapping for a plain string field */
function col(name: string, over: Partial<ActualTable['columns'][number]> = {}) {
  return { name, dataType: 'character varying', isNullable: true, columnDefault: null, udtName: 'varchar', ...over };
}

describe('pgTypeMatches — declared DDL type vs information_schema', () => {
  it('normalizes varchar/text/integer/boolean/date/jsonb/timestamptz', () => {
    expect(pgTypeMatches('VARCHAR(255)', { dataType: 'character varying' })).toBe(true);
    expect(pgTypeMatches('TEXT', { dataType: 'text' })).toBe(true);
    expect(pgTypeMatches('INTEGER', { dataType: 'integer' })).toBe(true);
    expect(pgTypeMatches('BOOLEAN', { dataType: 'boolean' })).toBe(true);
    expect(pgTypeMatches('DATE', { dataType: 'date' })).toBe(true);
    expect(pgTypeMatches('JSONB', { dataType: 'jsonb' })).toBe(true);
    expect(pgTypeMatches('TIMESTAMPTZ', { dataType: 'timestamp with time zone' })).toBe(true);
    expect(pgTypeMatches('TIMESTAMPTZ', { dataType: 'TIMESTAMP WITH TIME ZONE' })).toBe(true);
  });

  it('is false across base types', () => {
    expect(pgTypeMatches('VARCHAR(255)', { dataType: 'integer' })).toBe(false);
    expect(pgTypeMatches('TEXT', { dataType: 'character varying' })).toBe(false);
  });

  it('compares numeric precision/scale only when declared', () => {
    expect(pgTypeMatches('NUMERIC(12)', { dataType: 'numeric', numericPrecision: 12, numericScale: 0 })).toBe(true);
    expect(pgTypeMatches('NUMERIC(12)', { dataType: 'numeric', numericPrecision: 10, numericScale: 0 })).toBe(false);
    expect(pgTypeMatches('NUMERIC', { dataType: 'numeric', numericPrecision: 10 })).toBe(true);
    expect(pgTypeMatches('NUMERIC(12,2)', { dataType: 'numeric', numericPrecision: 12, numericScale: 2 })).toBe(true);
    expect(pgTypeMatches('NUMERIC(12,2)', { dataType: 'numeric', numericPrecision: 12, numericScale: 4 })).toBe(false);
  });

  it('compares array element types', () => {
    expect(pgTypeMatches('TEXT[]', { dataType: 'ARRAY', udtName: '_text' })).toBe(true);
    expect(pgTypeMatches('TEXT[]', { dataType: 'ARRAY', udtName: '_int4' })).toBe(false);
    expect(pgTypeMatches('TEXT[]', { dataType: 'text' })).toBe(false);
  });
});

describe('buildMappingReport — schema ↔ table mapping', () => {
  it('reports every field in sync', () => {
    const defs = [obj('customers', [ID, { name: 'name', type: 'string' }])];
    const actual = new Map<string, ActualTable>([
      ['customers', table({ name: 'customers', pk: ['id'], columns: [col('id', { isNullable: false }), col('name')] })],
    ]);

    const report = buildMappingReport(defs, actual);
    const table0 = report.tables[0]!;
    expect(table0.exists).toBe(true);
    expect(table0.drift).toBe(false);
    expect(table0.columns.map((c) => c.status)).toEqual(['ok', 'ok']);
    expect(report.totals).toMatchObject({ objects: 1, columns: 2, columnsOk: 2, tablesMissing: 0 });
  });

  it('flags a declared field whose column is missing', () => {
    const defs = [obj('customers', [ID, { name: 'name', type: 'string' }])];
    const actual = new Map<string, ActualTable>([
      ['customers', table({ name: 'customers', pk: ['id'], columns: [col('id', { isNullable: false })] })],
    ]);

    const report = buildMappingReport(defs, actual);
    expect(report.tables[0]!.drift).toBe(true);
    expect(report.tables[0]!.columns[1]).toMatchObject({ field: 'name', status: 'missing' });
    expect(report.totals).toMatchObject({ columnsMissing: 1, columnsOk: 1 });
  });

  it('flags type and nullability mismatches', () => {
    const defs = [obj('customers', [ID, { name: 'age', type: 'integer', required: true }])];
    const actual = new Map<string, ActualTable>([
      [
        'customers',
        table({
          name: 'customers',
          pk: ['id'],
          columns: [
            col('id', { isNullable: false, dataType: 'integer' }),
            col('age', { isNullable: true, dataType: 'character varying' }),
          ],
        }),
      ],
    ]);

    const report = buildMappingReport(defs, actual);
    expect(report.tables[0]!.columns[0]).toMatchObject({ status: 'type' });
    expect(report.tables[0]!.columns[1]).toMatchObject({ status: 'type' });
    expect(report.totals).toMatchObject({ columnsType: 2 });
  });

  it('flags a nullability-only mismatch', () => {
    const defs = [obj('customers', [ID, { name: 'name', type: 'string', required: true }])];
    const actual = new Map<string, ActualTable>([
      ['customers', table({ name: 'customers', pk: ['id'], columns: [col('id', { isNullable: false }), col('name')] })],
    ]);

    const report = buildMappingReport(defs, actual);
    expect(report.tables[0]!.columns[1]).toMatchObject({ status: 'nullable', actual: { nullableMatch: false } });
    expect(report.totals.columnsNullable).toBe(1);
  });

  it('reports undeclared DB columns as extra without treating them as drift', () => {
    const defs = [obj('customers', [ID])];
    const actual = new Map<string, ActualTable>([
      [
        'customers',
        table({ name: 'customers', pk: ['id'], columns: [col('id', { isNullable: false }), col('legacy_note', { dataType: 'text', udtName: 'text' })] }),
      ],
    ]);

    const report = buildMappingReport(defs, actual);
    expect(report.tables[0]!.columns[1]).toMatchObject({ field: '-', column: 'legacy_note', status: 'extra' });
    expect(report.tables[0]!.drift).toBe(false);
    expect(report.totals.columnsExtra).toBe(1);
  });

  it('maps declared table-level UNIQUE constraints and counts constraint drift', () => {
    const defs = [
      parseSchema(
        JSON.stringify({
          name: 'memberships',
          fields: [ID, { name: 'user_id', type: 'string' }, { name: 'team_id', type: 'string' }],
          constraints: [{ type: 'unique', fields: ['user_id', 'team_id'] }],
        }),
        { nameHint: 'memberships' },
      ),
    ];
    const columns = [col('id', { isNullable: false }), col('user_id'), col('team_id')];
    const missing = buildMappingReport(defs, new Map([['memberships', table({ name: 'memberships', pk: ['id'], columns })]]));
    const memberships = report(missing, 'memberships');
    expect(memberships.constraints[0]).toMatchObject({
      name: 'memberships_user_id_team_id_key',
      columns: ['user_id', 'team_id'],
      present: false,
    });
    expect(memberships.drift).toBe(true);
    expect(missing.totals.constraintDrift).toBe(1);

    const present = buildMappingReport(
      defs,
      new Map([
        [
          'memberships',
          table({ name: 'memberships', pk: ['id'], columns, indexNames: ['memberships_pkey', 'memberships_user_id_team_id_key'] }),
        ],
      ]),
    );
    expect(report(present, 'memberships').constraints[0]!.present).toBe(true);
    expect(present.totals.constraintDrift).toBe(0);
  });

  it('reports a missing table with every column missing', () => {    const defs = [obj('customers', [ID])];
    const report = buildMappingReport(defs, new Map());

    expect(report.tables[0]).toMatchObject({ exists: false, drift: true });
    expect(report.tables[0]!.columns[0]!.status).toBe('missing');
    expect(report.tables[0]!.warnings[0]).toContain('does not exist yet');
    expect(report.totals.tablesMissing).toBe(1);
  });

  it('maps a relation to its FK target and flags a missing constraint/index', () => {
    const defs = [obj('customers', [ID]), obj('orders', [ID, { name: 'customer_id', type: 'relation', target: 'customers' }])];
    const actual = new Map<string, ActualTable>([
      ['customers', table({ name: 'customers', pk: ['id'], columns: [col('id', { isNullable: false })] })],
      [
        'orders',
        table({ name: 'orders', pk: ['id'], columns: [col('id', { isNullable: false }), col('customer_id', { isNullable: true })] }),
      ],
    ]);

    const result = buildMappingReport(defs, actual);
    const orders = report(result, 'orders');
    expect(orders.columns[1]).toMatchObject({
      field: 'customer_id',
      schemaType: 'relation → customers.id',
      status: 'ok',
      fk: { table: 'customers', column: 'id', onDelete: 'restrict' },
    });
    expect(orders.fks[0]).toMatchObject({ column: 'customer_id', present: false });
    expect(orders.indexes[0]).toMatchObject({ name: 'orders_customer_id_idx', present: false });
    expect(orders.drift).toBe(true);
    expect(result.totals).toMatchObject({ indexDrift: 1, fkDrift: 1 });
  });

  it('adds engine-managed details-child columns and lists the edge on the parent', () => {
    const defs = [
      obj('orders', [ID, { name: 'items', type: 'details', target: 'order_items' }]),
      obj('order_items', [ID, { name: 'qty', type: 'integer' }]),
    ];
    const actual = new Map<string, ActualTable>([
      [
        'order_items',
        table({
          name: 'order_items',
          pk: ['id'],
          indexNames: ['order_items_pkey', 'order_items_parent_idx'],
          columns: [
            col('id', { isNullable: false }),
            col('qty', { dataType: 'integer', udtName: 'int4' }),
            col('parent_id', { isNullable: false }),
            col('parent_type', { isNullable: false }),
            col('parent_idx', { dataType: 'integer', udtName: 'int4', isNullable: false, columnDefault: '1' }),
          ],
        }),
      ],
    ]);

    const result = buildMappingReport(defs, actual);
    const parent = report(result, 'orders');
    expect(parent.details).toEqual([{ field: 'items', target: 'order_items' }]);
    const child = report(result, 'order_items');
    expect(child.columns.filter((c) => c.auto === true).map((c) => c.column)).toEqual([
      'parent_id',
      'parent_type',
      'parent_idx',
    ]);
    expect(child.drift).toBe(false);
  });
});

function report(reportValue: ReturnType<typeof buildMappingReport>, name: string) {
  const found = reportValue.tables.find((t) => t.object === name);
  if (found === undefined) throw new Error(`no table ${name}`);
  return found;
}
