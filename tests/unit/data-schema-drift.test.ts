import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, SchemaError, createDataAccess, defineObject } from '../../src/index.js';
import type { DataAccessContext } from '../../src/runtime/data-access/index.js';

/** a pool whose queries always throw a PG undefined_column (42703) error */
function driftPool() {
  return {
    query: async () => {
      const err = new Error('column "ghost" of relation "lead" does not exist') as Error & { code?: string };
      err.code = '42703';
      throw err;
    },
  };
}

const LEAD = defineObject({
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'ghost', type: 'string' },
  ],
});

describe('data-access — PG 42703 → data.schemaDrift (query-time fallback)', () => {
  it('find referencing missing column → mapped to data.schemaDrift (with object/field)', async () => {
    const registry = new ObjectRegistry();
    registry.register(LEAD);
    const dataAccess = createDataAccess();
    const ctx = { pool: driftPool(), registry, locale: 'en' } as unknown as DataAccessContext;
    let caught: SchemaError | undefined;
    try {
      await dataAccess.find('lead', {}, ctx);
    } catch (e) {
      caught = e instanceof SchemaError ? e : undefined;
    }
    expect(caught).not.toBeUndefined();
    expect(caught!.code).toBe('data.schemaDrift');
    expect(caught!.params.object).toBe('lead');
    expect(caught!.params.field).toBe('ghost');
  });
});
