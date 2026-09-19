import { describe, it, expect } from '../helpers/test.js';import { createPool, inspectSchema, migrate, ObjectRegistry } from '../../src/core/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Migration E2E (local PG)', () => {
  it('create tables + relation FK + details child table automatic columns', async () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'supplier', fields: [{ name: 'id', type: 'string', primary: true }] });
    reg.register({
      name: 'order',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'supplier_id', type: 'relation', target: 'supplier' },
        { name: 'amount', type: 'currency', required: true },
        { name: 'lines', type: 'details', target: 'line' },
      ],
    });
    reg.register({ name: 'line', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'qty', type: 'integer' }] });

    const result = await migrate(reg, { databaseUrl: url });
    expect(result.statements.length).toBeGreaterThan(0);
    expect(result.applied).toContain('supplier');
    expect(result.applied).toContain('order');

    const pool = createPool(url!);
    try {
      const actual = await inspectSchema(pool);
      expect(actual.has('supplier')).toBe(true);
      expect(actual.has('order')).toBe(true);
      expect(actual.has('line')).toBe(true);

      const order = actual.get('order')!;
      expect(order.pk).toEqual(['id']);
      expect(order.fks.some((f) => f.column === 'supplier_id' && f.refTable === 'supplier')).toBe(true);

      const line = actual.get('line')!;
      expect(line.columns.map((c) => c.name)).toEqual(
        expect.arrayContaining(['id', 'qty', 'parent_id', 'parent_type', 'parent_idx']),
      );

      const meta = await pool.query(`SELECT key, value FROM weavekit_meta WHERE key = 'schema.applied.order'`);
      expect(meta.rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('idempotent: re-migration emits no statements', async () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'supplier', fields: [{ name: 'id', type: 'string', primary: true }] });
    reg.register({
      name: 'order',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'supplier_id', type: 'relation', target: 'supplier' },
      ],
    });
    const again = await migrate(reg, { databaseUrl: url });
    expect(again.statements).toEqual([]);
    expect(again.applied).toEqual([]);
  });

  it('details field object second migration idempotent (details has no parent table column, not misjudged as ghost-column)', async () => {
    const cleanup = createPool(url!);
    await cleanup.query('DROP TABLE IF EXISTS order2, line2, supplier CASCADE');
    await cleanup.end();
    const reg = new ObjectRegistry();
    reg.register({ name: 'supplier', fields: [{ name: 'id', type: 'string', primary: true }] });
    reg.register({
      name: 'order2',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'supplier_id', type: 'relation', target: 'supplier' },
        { name: 'lines', type: 'details', target: 'line2' },
      ],
    });
    reg.register({ name: 'line2', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'qty', type: 'integer' }] });
    const pool = createPool(url!);
    try {
      const first = await migrate(reg, { databaseUrl: url });
      expect(first.applied).toContain('order2');
      // re-migrating an existing table must not treat `lines` (a details field,
      // which has no column on the parent — the child carries parent_* columns)
      // as a ghost column. Regression: demo re-run of `weave migrate`.
      const again = await migrate(reg, { databaseUrl: url });
      expect(again.statements).toEqual([]);
      expect(again.applied).toEqual([]);
    } finally {
      await pool.query('DROP TABLE IF EXISTS order2, line2, supplier CASCADE');
      await pool.end();
    }
  });

  it('adding a field to an existing table rejected (engine does not ALTER existing tables)', async () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'supplier', fields: [{ name: 'id', type: 'string', primary: true }] });
    reg.register({
      name: 'order',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'supplier_id', type: 'relation', target: 'supplier' },
        { name: 'note', type: 'text' }, // note is not among the created table's columns
      ],
    });
    let caught: Error | undefined;
    try {
      await migrate(reg, { databaseUrl: url });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('field "note" does not exist as a column in existing table "order"');
  });

  it('dryRun does not execute', async () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'ghost', fields: [{ name: 'id', type: 'string', primary: true }] });
    const result = await migrate(reg, { databaseUrl: url, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.statements.some((s) => s.includes('CREATE TABLE "ghost"'))).toBe(true);

    const pool = createPool(url!);
    try {
      const actual = await inspectSchema(pool);
      expect(actual.has('ghost')).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it('new object (table for object name does not exist) → auto CREATE TABLE', async () => {
    const pool = createPool(url!);
    await pool.query('DROP TABLE IF EXISTS "fresh"');
    await pool.end();
    const reg = new ObjectRegistry();
    reg.register({ name: 'fresh', fields: [{ name: 'id', type: 'string', primary: true }] });
    const result = await migrate(reg, { databaseUrl: url });
    expect(result.statements.some((s) => s.includes('CREATE TABLE "fresh"'))).toBe(true);
  });

  it('existing table (object name exists) primary column missing → object.primary.columnMissing', async () => {
    const pool = createPool(url!);
    await pool.query('DROP TABLE IF EXISTS "legacy"');
    await pool.query('CREATE TABLE "legacy" (name text)');
    await pool.end();
    const reg = new ObjectRegistry();
    reg.register({
      name: 'legacy',
      fields: [{ name: 'id', type: 'string', primary: true }],
    });
    let caught: Error | undefined;
    try {
      await migrate(reg, { databaseUrl: url });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('primary column "id" not found in existing table "legacy"');
  });

  it('existing table declared field column missing → object.field.columnMissing', async () => {
    const pool = createPool(url!);
    await pool.query('DROP TABLE IF EXISTS "legacy"');
    await pool.query('CREATE TABLE "legacy" (id text PRIMARY KEY)');
    await pool.end();
    const reg = new ObjectRegistry();
    reg.register({
      name: 'legacy',
      fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }],
    });
    let caught: Error | undefined;
    try {
      await migrate(reg, { databaseUrl: url });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('field "name" does not exist as a column in existing table "legacy"');
  });

  it('existing table primary + all field columns exist → migration passes (zero DDL)', async () => {
    const pool = createPool(url!);
    await pool.query('DROP TABLE IF EXISTS "legacy"');
    await pool.query('CREATE TABLE "legacy" (id text PRIMARY KEY, name text)');
    await pool.end();
    const reg = new ObjectRegistry();
    reg.register({
      name: 'legacy',
      fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }],
    });
    const result = await migrate(reg, { databaseUrl: url });
    expect(result.statements.some((s) => s.includes('CREATE TABLE "legacy"'))).toBe(false);
  });

  it('alter: existing table declared field column missing → auto ADD COLUMN (additive-only, triggered by schema.alter: true)', async () => {
    const pool = createPool(url!);
    await pool.query('DROP TABLE IF EXISTS "alter_t"');
    await pool.query('CREATE TABLE "alter_t" (id text PRIMARY KEY)');
    await pool.end();
    const reg = new ObjectRegistry();
    reg.register({
      name: 'alter_t',
      alter: true,
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'currency' },
      ],
    });
    const result = await migrate(reg, { databaseUrl: url });
    expect(result.statements.some((s) => s.includes('ALTER TABLE "alter_t" ADD COLUMN "name" VARCHAR(255)'))).toBe(true);
    expect(result.statements.some((s) => s.includes('ALTER TABLE "alter_t" ADD COLUMN "amount" NUMERIC(12,2)'))).toBe(true);
    expect(result.applied).toContain('alter_t');

    const pool2 = createPool(url!);
    try {
      const actual = await inspectSchema(pool2);
      const t = actual.get('alter_t')!;
      expect(t.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'name', 'amount']));
    } finally {
      await pool2.end();
    }
  });

  it('alter: rerun idempotent (zero statements)', async () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'alter_t',
      alter: true,
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'currency' },
      ],
    });
    const again = await migrate(reg, { databaseUrl: url });
    expect(again.statements).toEqual([]);
    expect(again.applied).toEqual([]);
  });

  it('alter: missing PK column still throws object.primary.columnMissing (not glossed over)', async () => {
    const pool = createPool(url!);
    await pool.query('DROP TABLE IF EXISTS "alter_pk"');
    await pool.query('CREATE TABLE "alter_pk" (name text)');
    await pool.end();
    const reg = new ObjectRegistry();
    reg.register({ name: 'alter_pk', fields: [{ name: 'id', type: 'string', primary: true }] });
    let caught: Error | undefined;
    try {
      await migrate(reg, { databaseUrl: url });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('primary column "id" not found in existing table "alter_pk"');
  });

  it('clean up test tables', async () => {
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS "order", "line", "supplier", "ghost", "legacy", "fresh", "alter_t", "alter_pk", weavekit_meta');
    } finally {
      await pool.end();
    }
  });
});
