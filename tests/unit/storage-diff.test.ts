import { describe, it, expect } from '../helpers/test.js';import { buildExpectedTable, diffAll, diffTable, ObjectRegistry, onDeleteClause } from '../../src/core/index.js';
import type { ActualTable } from '../../src/core/index.js';

function registryOf(entries: Record<string, unknown>): ObjectRegistry {
  const reg = new ObjectRegistry();
  for (const d of Object.values(entries)) reg.register(d);
  return reg;
}

function defsOf(reg: ObjectRegistry): Map<string, import('../../src/core/index.js').ObjectDefinition> {
  return new Map(reg.list().map((d) => [d.name, d]));
}

const emptyActual = (): Map<string, ActualTable> => new Map();

describe('buildExpectedTable — expected table construction', () => {
  it('relation → FK + index; enum → index; unique flag', () => {
    const reg = registryOf({
      supplier: { name: 'supplier', fields: [{ name: 'id', type: 'string', primary: true }] },
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'supplier_id', type: 'relation', target: 'supplier' },
          { name: 'status', type: 'enum', options: ['draft', 'ok'] },
          { name: 'code', type: 'string', unique: true },
        ],
      },
    });
    const t = buildExpectedTable(reg.get('order')!, defsOf(reg));
    expect(t.name).toBe('order');
    expect(t.fks).toEqual([
      { column: 'supplier_id', refTable: 'supplier', refColumn: 'id', onDelete: 'restrict' },
    ]);
    expect(t.indexes.map((i) => i.columns)).toContainEqual(['supplier_id']);
    expect(t.columns.find((c) => c.name === 'code')?.unique).toBe(true);
  });

  it('details child table auto three columns + composite index', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'lines', type: 'details', target: 'line' },
        ],
      },
      line: { name: 'line', fields: [{ name: 'id', type: 'string', primary: true }] },
    });
    const t = buildExpectedTable(reg.get('line')!, defsOf(reg));
    expect(t.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'parent_type', 'parent_idx']);
    expect(t.columns.find((c) => c.name === 'parent_idx')).toMatchObject({ type: 'INTEGER', notNull: true });
    expect(t.indexes).toContainEqual({ name: 'line_parent_idx', method: 'btree', columns: ['parent_type', 'parent_id'] });
  });

  it('object name is table name (no table attribute)', () => {
    const reg = registryOf({
      customer: {
        name: 'customer',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
    });
    const t = buildExpectedTable(reg.get('customer')!, defsOf(reg));
    expect(t.name).toBe('customer');
    expect(t.columns.map((c) => c.name)).toEqual(['id']);
  });
});

describe('diffTable / diffAll — DDL generation', () => {
  it('new object → CREATE TABLE (with PK/unique/index), FK after tables', () => {
    const reg = registryOf({
      supplier: { name: 'supplier', fields: [{ name: 'id', type: 'string', primary: true }] },
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'supplier_id', type: 'relation', target: 'supplier' },
        ],
      },
    });
    const defs = defsOf(reg);
    const statements = diffAll(
      [buildExpectedTable(reg.get('supplier')!, defs), buildExpectedTable(reg.get('order')!, defs)],
      emptyActual(),
    );
    expect(statements[0]).toContain('CREATE TABLE "supplier"');
    expect(statements[1]).toContain('CREATE TABLE "order"');
    expect(statements.join('\n')).toContain('CONSTRAINT "order_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT');
  });

  it('missing column → ALTER TABLE ADD COLUMN', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'amount', type: 'currency' },
        ],
      },
    });
    const defs = defsOf(reg);
    const t = buildExpectedTable(reg.get('order')!, defs);
    const actual = new Map<string, ActualTable>([
      ['order', { name: 'order', columns: [{ name: 'id', dataType: 'character varying', isNullable: false, columnDefault: null }], pk: ['id'], fks: [], indexNames: [] }],
    ]);
    const stmts = diffTable(t, actual.get('order'));
    expect(stmts.some((s) => s.includes('ADD COLUMN "amount" NUMERIC(12,2)'))).toBe(true);
  });

  it('idempotent: actual matches expected → no statements', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
    });
    const defs = defsOf(reg);
    const t = buildExpectedTable(reg.get('order')!, defs);
    const actual = new Map<string, ActualTable>([
      ['order', { name: 'order', columns: [{ name: 'id', dataType: 'character varying', isNullable: false, columnDefault: null }], pk: ['id'], fks: [], indexNames: [] }],
    ]);
    expect(diffTable(t, actual.get('order'))).toEqual([]);
    expect(diffAll([t], actual)).toEqual([]);
  });

  it('missing unique constraint → ADD CONSTRAINT; enum auto index → CREATE INDEX', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'code', type: 'string', unique: true },
          { name: 'status', type: 'enum', options: ['draft', 'ok'] },
        ],
      },
    });
    const defs = defsOf(reg);
    const t = buildExpectedTable(reg.get('order')!, defs);
    const actual = new Map<string, ActualTable>([
      ['order', {
        name: 'order',
        columns: [
          { name: 'id', dataType: 'character varying', isNullable: false, columnDefault: null },
          { name: 'code', dataType: 'character varying', isNullable: true, columnDefault: null },
          { name: 'status', dataType: 'character varying', isNullable: true, columnDefault: null },
        ],
        pk: ['id'],
        fks: [],
        indexNames: [],
      }],
    ]);
    const stmts = diffTable(t, actual.get('order'));
    expect(stmts.some((s) => s.includes('ADD CONSTRAINT "order_code_key" UNIQUE ("code")'))).toBe(true);
    expect(stmts.some((s) => s.startsWith('CREATE INDEX "order_status_idx"'))).toBe(true);
  });

  it('details child table auto columns + GIN multi-select index', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'lines', type: 'details', target: 'line' },
          { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true },
        ],
      },
      line: { name: 'line', fields: [{ name: 'id', type: 'string', primary: true }] },
    });
    const defs = defsOf(reg);
    const line = buildExpectedTable(reg.get('line')!, defs);
    const order = buildExpectedTable(reg.get('order')!, defs);
    expect(line.columns.map((c) => c.name)).toContain('parent_id');
    expect(order.indexes.some((i) => i.method === 'gin' && i.columns[0] === 'tags')).toBe(true);
  });

  it('onDelete=set_null → FK uses `SET NULL` (not `SET_NULL`)', () => {
    const reg = registryOf({
      supplier: { name: 'supplier', fields: [{ name: 'id', type: 'string', primary: true }] },
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'supplier_id', type: 'relation', target: 'supplier', onDelete: 'set_null' },
        ],
      },
    });
    const defs = defsOf(reg);
    const statements = diffAll(
      [buildExpectedTable(reg.get('supplier')!, defs), buildExpectedTable(reg.get('order')!, defs)],
      emptyActual(),
    );
    expect(statements.join('\n')).toContain('ON DELETE SET NULL');
    expect(statements.join('\n')).not.toContain('ON DELETE SET_NULL');
  });

  it('onDelete action → SQL clause mapping (cascade/set_null/restrict/unknown)', () => {
    expect(onDeleteClause('cascade')).toBe('CASCADE');
    expect(onDeleteClause('set_null')).toBe('SET NULL');
    expect(onDeleteClause('restrict')).toBe('RESTRICT');
    expect(onDeleteClause(undefined)).toBe('RESTRICT');
    expect(onDeleteClause('weird' as string)).toBe('RESTRICT');
  });
});

describe('diffTable — additive safety (H1: non-null column without default errors directly on existing table)', () => {
  const existing = (): Map<string, ActualTable> =>
    new Map([
      ['order', {
        name: 'order',
        columns: [{ name: 'id', dataType: 'character varying', isNullable: false, columnDefault: null }],
        pk: ['id'],
        fks: [],
        indexNames: [],
      }],
    ]);

  it('existing table + required without default → throws storage.alter.requiredNoDefault', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'ref_no', type: 'string', required: true },
        ],
      },
    });
    const t = buildExpectedTable(reg.get('order')!, defsOf(reg));
    let caught: { code?: string } | undefined;
    try {
      diffTable(t, existing().get('order'));
    } catch (e) {
      caught = e as { code?: string };
    }
    expect(caught?.code).toBe('storage.alter.requiredNoDefault');
  });

  it('existing table + required with default → normal ADD COLUMN … DEFAULT … NOT NULL', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'status', type: 'enum', options: ['draft', 'ok'], required: true, default: 'draft' },
        ],
      },
    });
    const t = buildExpectedTable(reg.get('order')!, defsOf(reg));
    const stmts = diffTable(t, existing().get('order'));
    expect(stmts.some((s) => s.includes('ADD COLUMN "status"') && s.includes('DEFAULT') && s.includes('NOT NULL'))).toBe(true);
  });

  it('new object (no actual) + required without default → does not throw (CREATE TABLE safe)', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'ref_no', type: 'string', required: true },
        ],
      },
    });
    const t = buildExpectedTable(reg.get('order')!, defsOf(reg));
    expect(() => diffTable(t, undefined)).not.toThrow();
  });
});
