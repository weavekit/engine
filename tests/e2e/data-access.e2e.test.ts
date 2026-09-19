import { describe, it, expect } from '../helpers/test.js';import { createDataAccess, createPool, migrate, ObjectRegistry, SchemaError } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Data access E2E (local PG)', () => {
  it('CRUD/details/formula/seq_no full path', async () => {
  const registry = new ObjectRegistry();
  registry.register({ name: 'supplier', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }, { name: 'region', type: 'string' }] });
  registry.register({
    name: 'order',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'supplier_id', type: 'relation', target: 'supplier' },
      { name: 'status', type: 'enum', options: ['open', 'closed'], default: 'open' },
      { name: 'tags', type: 'enum', options: ['a', 'b', 'c'], multiple: true },
      { name: 'doc_no', type: 'seq_no', format: 'O-{year}-{seq:4}', cycle: 'year' },
      { name: 'total', type: 'number', formula: 'SUM(lines.qty)' },
      { name: 'region', type: 'string', formula: 'supplier_id.region' },
      { name: 'lines', type: 'details', target: 'line' },
    ],
  });
  registry.register({ name: 'line', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'qty', type: 'integer' }] });

  const dataAccess = createDataAccess();
  const pool = createPool(url!, { query_timeout: 5000, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
  try {
    // clean any leftover state, then create schema
    await pool.query('DROP TABLE IF EXISTS "order", "line", "supplier", weavekit_seq, weavekit_meta CASCADE');
    await migrate(registry, { databaseUrl: url });
    const ctx = { pool, registry };

    // create: seq_no + formula (aggregate/cross-object) + nested details
    await dataAccess.create('supplier', { id: 's1', region: 'East' }, ctx);
    const order = await dataAccess.create('order', {
      id: 'o1',
      supplier_id: 's1',
      tags: ['a', 'b'],
      lines: [
        { id: 'l1', qty: 2 },
        { id: 'l2', qty: 1 },
      ],
    }, ctx);
    expect(order.doc_no).toBe('O-2026-0001');
    expect(order.total).toBe(3);
    expect(order.region).toBe('East');

    const childLines = await dataAccess.find('line', { filter: { parent_id: 'o1' }, sort: [{ field: 'parent_idx', dir: 'asc' }] }, ctx);
    expect(childLines.rows).toHaveLength(2);
    expect(childLines.rows[0]).toMatchObject({ parent_id: 'o1', parent_type: 'order', parent_idx: 1 });
    expect(childLines.rows[1]).toMatchObject({ parent_id: 'o1', parent_type: 'order', parent_idx: 2 });

    // find: filter/contains/sort/pagination + { rows, total }
    await dataAccess.create('order', { id: 'o2', supplier_id: 's1', tags: ['a'] }, ctx);
    const open = await dataAccess.find('order', { filter: { status: 'open' } }, ctx);
    expect(open.total).toBe(2);
    const tagged = await dataAccess.find('order', { filter: { tags: { contains: ['a'] } } }, ctx);
    expect(tagged.total).toBe(2);
    const paged = await dataAccess.find('order', { filter: { status: 'open' }, sort: [{ field: 'doc_no', dir: 'asc' }], limit: 1, offset: 0 }, ctx);
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(2);

    // findOne / update: parent field update does not touch child table / nested update rejected
    const one = await dataAccess.findOne('order', 'o1', ctx);
    expect(one?.region).toBe('East');
    await dataAccess.update('order', 'o1', { status: 'closed' }, ctx);
    expect((await dataAccess.find('line', { filter: { parent_id: 'o1' } }, ctx)).total).toBe(2);
    try {
      await dataAccess.update('order', 'o1', { lines: [{ id: 'x', qty: 9 }] }, ctx);
      throw new Error('expected nested details rejection');
    } catch (e) {
      expect((e as Error).message).toMatch(/nested details/);
    }

    // child object independent CRUD (parent_idx automatic)
    const l3 = await dataAccess.create('line', { id: 'l3', qty: 5, parent_id: 'o1', parent_type: 'order' }, ctx);
    expect(l3.parent_idx).toBe(3);
    await dataAccess.update('line', 'l3', { qty: 4 }, ctx);
    expect((await dataAccess.findOne('line', 'l3', ctx))?.qty).toBe(4);
    await dataAccess.delete('line', 'l3', ctx);
    expect((await dataAccess.find('line', { filter: { parent_id: 'o1' } }, ctx)).total).toBe(2);

    // seq_no increment + deleting missing record errors
    try {
      await dataAccess.delete('order', 'ghost', ctx);
      throw new Error('expected SchemaError on missing record');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError);
    }
    const o3 = await dataAccess.create('order', { id: 'o3', supplier_id: 's1' }, ctx);
    expect(o3.doc_no).toBe('O-2026-0003');

    // delete parent cascades to children
    await dataAccess.delete('order', 'o1', ctx);
    expect((await dataAccess.find('line', { filter: { parent_id: 'o1' } }, ctx)).total).toBe(0);
    await dataAccess.delete('order', 'o2', ctx);
    await dataAccess.delete('order', 'o3', ctx);
  } finally {
    await pool.query('DROP TABLE IF EXISTS "order", "line", "supplier", weavekit_seq, weavekit_meta CASCADE');
    await pool.end();
  }
  }, 30000);

  it('Existing-table object (object name is table name) supports CRUD', async () => {
    const registry = new ObjectRegistry();
    registry.register({
      name: 'legacy_tbl',
      fields: [
        { name: 'doc_no', type: 'string', primary: true },
        { name: 'name', type: 'string' },
      ],
    });
    const dataAccess = createDataAccess();
    const pool = createPool(url!, { query_timeout: 5000, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
    try {
      await pool.query('DROP TABLE IF EXISTS "legacy_tbl"');
      await pool.query('CREATE TABLE "legacy_tbl" (doc_no text PRIMARY KEY, name text)');
      await migrate(registry, { databaseUrl: url }); // existing table: read-only, passes validation
      const ctx = { pool, registry };

      await dataAccess.create('legacy_tbl', { doc_no: 'D1', name: 'Alpha' }, ctx);
      expect((await dataAccess.findOne('legacy_tbl', 'D1', ctx))?.name).toBe('Alpha');
      await dataAccess.update('legacy_tbl', 'D1', { name: 'Beta' }, ctx);
      expect((await dataAccess.findOne('legacy_tbl', 'D1', ctx))?.name).toBe('Beta');
      await dataAccess.delete('legacy_tbl', 'D1', ctx);
      expect(await dataAccess.findOne('legacy_tbl', 'D1', ctx)).toBeNull();
    } finally {
      await pool.query('DROP TABLE IF EXISTS "legacy_tbl"');
      await pool.end();
    }
  }, 30000);
});
