import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, SchemaError } from '../../src/core/index.js';
import { validateRecord } from '../../src/runtime/data-access/validate.js';
import { WRITE_MODES } from '../../src/runtime/data-access/values.js';

/** a pool that always reports the referenced row exists */
const foundPool = { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) };

function build(relationField: Record<string, unknown>, pkType = 'integer') {
  const registry = new ObjectRegistry({});
  registry.register({ name: 'customer', fields: [{ name: 'id', type: pkType, primary: true }] });
  const def = registry.register({
    name: 'order',
    fields: [{ name: 'id', type: 'string', primary: true }, relationField],
  });
  registry.buildGraph();
  return { registry, def };
}

async function codeOfWrite(def: unknown, data: Record<string, unknown>, registry: ObjectRegistry): Promise<string | undefined> {
  try {
    await validateRecord(def as never, data, WRITE_MODES.CREATE, { pool: foundPool as never, registry, locale: 'en' });
    return undefined;
  } catch (error) {
    return error instanceof SchemaError ? error.code : undefined;
  }
}

describe('record references are typed by the target primary key', () => {
  it('accepts a numeric value for a relation to an integer primary key', async () => {
    const { registry, def } = build({ name: 'customer_id', type: 'relation', target: 'customer' });
    expect(await codeOfWrite(def, { id: 'o1', customer_id: 42 }, registry)).toBeUndefined();
  });

  it('rejects a string value for a relation to an integer primary key', async () => {
    const { registry, def } = build({ name: 'customer_id', type: 'relation', target: 'customer' });
    expect(await codeOfWrite(def, { id: 'o1', customer_id: '42' }, registry)).toBe('data.field.type');
  });

  it('still accepts a string value for a relation to a string primary key', async () => {
    const { registry, def } = build({ name: 'customer_id', type: 'relation', target: 'customer' }, 'string');
    expect(await codeOfWrite(def, { id: 'o1', customer_id: 'c-1' }, registry)).toBeUndefined();
    expect(await codeOfWrite(def, { id: 'o1', customer_id: 42 }, registry)).toBe('data.field.type');
  });

  it('type-checks each element of a multiRelation to an integer primary key', async () => {
    const { registry, def } = build({ name: 'customer_ids', type: 'multiRelation', target: 'customer' });
    const pool = { query: async (_sql: string, params: unknown[]) => ({ rows: [], rowCount: (params[0] as unknown[]).length }) };
    await validateRecord(def, { id: 'o1', customer_ids: [1, 2] }, WRITE_MODES.CREATE, { pool: pool as never, registry, locale: 'en' });
    expect(await codeOfWrite(def, { id: 'o1', customer_ids: ['1'] }, registry)).toBe('data.field.type');
  });
});
