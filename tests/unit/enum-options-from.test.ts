import { describe, it, expect } from '../helpers/test.js';
import {
  describeObject,
  generateObjectTypes,
  ObjectRegistry,
  SchemaError,
  validateObject,
} from '../../src/core/index.js';
import { fieldSchema } from '../../src/adapters/openapi/schema.js';
import { normalizeFieldTypeRegistration } from '../../src/runtime/fieldtypes/index.js';
import { validateRecord } from '../../src/runtime/data-access/validate.js';
import { WRITE_MODES } from '../../src/runtime/data-access/values.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** a pool that resolves membership queries from an in-memory allowed set */
function lookupPool(allowed: readonly string[]) {
  const set = new Set(allowed);
  return {
    async query(_sql: string, params: unknown[]) {
      const p = params[0];
      if (Array.isArray(p)) {
        const matched = p.filter((v) => set.has(String(v)));
        return { rows: matched.map((v) => ({ v })), rowCount: matched.length };
      }
      return set.has(String(p))
        ? { rows: [{ ok: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    },
  };
}

function invoice(field: Record<string, unknown>): unknown {
  return { name: 'invoice', fields: [{ name: 'id', type: 'string', primary: true }, field] };
}

describe('enum options — inline vs data-driven (`{ from }`)', () => {
  it('accepts an inline array (regression) and a `{ from }` object', () => {
    const inline = validateObject(invoice({ name: 'status', type: 'enum', options: ['draft', 'done'] }));
    expect((inline.fields[1] as { options?: unknown }).options).toEqual(['draft', 'done']);

    const dynamic = validateObject(invoice({ name: 'ccy', type: 'enum', options: { from: { object: 'currency', column: 'code' } } }));
    expect((dynamic.fields[1] as { options?: unknown }).options).toEqual({ from: { object: 'currency', column: 'code' } });
  });

  it('accepts `{ from }` with `multiple`', () => {
    const def = validateObject(
      invoice({ name: 'tags', type: 'enum', multiple: true, options: { from: { object: 'tag', column: 'code' } } }),
    );
    expect((def.fields[1] as { multiple?: boolean }).multiple).toBe(true);
  });

  it('rejects malformed option shapes', () => {
    expect(codeOf(() => validateObject(invoice({ name: 'a', type: 'enum', options: {} })))).toBe('field.enum.options.shape');
    expect(codeOf(() => validateObject(invoice({ name: 'a', type: 'enum', options: { from: {} } })))).toBe(
      'field.enum.options.shape',
    );
    expect(codeOf(() => validateObject(invoice({ name: 'a', type: 'enum', options: { from: { object: 'Bad' } } })))).toBe(
      'field.enum.options.shape',
    );
    expect(codeOf(() => validateObject(invoice({ name: 'a', type: 'enum', options: { from: { object: 'x', column: 'Bad' } } })))).toBe(
      'field.enum.options.shape',
    );
  });

  it('rejects `default` when options are data-driven', () => {
    expect(
      codeOf(() =>
        validateObject(
          invoice({ name: 'ccy', type: 'enum', options: { from: { object: 'currency', column: 'code' } }, default: 'USD' }),
        ),
      ),
    ).toBe('field.default.optionsFrom');
  });
});

describe('AttrSpec.default validation (loader)', () => {
  it('accepts a default matching the attr kind', () => {
    expect(
      codeOf(() => normalizeFieldTypeRegistration({ namespace: 'x', name: 't', base: 'integer', attrs: { n: { type: 'integer', default: 2 } } })),
    ).toBeUndefined();
    expect(
      codeOf(() => normalizeFieldTypeRegistration({ namespace: 'x', name: 't', base: 'string', attrs: { c: { type: 'enum', values: ['a', 'b'], default: 'a' } } })),
    ).toBeUndefined();
  });

  it('rejects a default that does not match the attr kind', () => {
    expect(
      codeOf(() => normalizeFieldTypeRegistration({ namespace: 'x', name: 't', base: 'string', attrs: { n: { type: 'integer', default: 'nope' } } })),
    ).toBe('fieldtype.attr.invalid');
    expect(
      codeOf(() => normalizeFieldTypeRegistration({ namespace: 'x', name: 't', base: 'string', attrs: { c: { type: 'enum', values: ['a', 'b'], default: 'z' } } })),
    ).toBe('fieldtype.attr.invalid');
  });
});

describe('enum options.from — graph validation', () => {
  it('accepts a valid object/column source', () => {
    const registry = new ObjectRegistry({});
    registry.register({ name: 'currency', fields: [{ name: 'code', type: 'string', primary: true }] });
    registry.register(invoice({ name: 'ccy', type: 'enum', options: { from: { object: 'currency', column: 'code' } } }));
    expect(codeOf(() => registry.buildGraph())).toBeUndefined();
  });

  it('rejects a missing target object', () => {
    const registry = new ObjectRegistry({});
    registry.register(invoice({ name: 'ccy', type: 'enum', options: { from: { object: 'ghost' } } }));
    expect(codeOf(() => registry.buildGraph())).toBe('graph.optionsFrom.target.missing');
  });

  it('rejects a missing target column', () => {
    const registry = new ObjectRegistry({});
    registry.register({ name: 'currency', fields: [{ name: 'code', type: 'string', primary: true }] });
    registry.register(invoice({ name: 'ccy', type: 'enum', options: { from: { object: 'currency', column: 'nope' } } }));
    expect(codeOf(() => registry.buildGraph())).toBe('graph.optionsFrom.column.missing');
  });

  it('accepts a scalar (numeric) target column — values are stringified', () => {
    const registry = new ObjectRegistry({});
    registry.register({ name: 'level', fields: [{ name: 'n', type: 'integer', primary: true }] });
    registry.register(invoice({ name: 'lv', type: 'enum', options: { from: { object: 'level', column: 'n' } } }));
    expect(codeOf(() => registry.buildGraph())).toBeUndefined();
  });

  it('rejects a json / relation / array target column', () => {
    const json = new ObjectRegistry({});
    json.register({ name: 'doc', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'body', type: 'json' }] });
    json.register(invoice({ name: 'v', type: 'enum', options: { from: { object: 'doc', column: 'body' } } }));
    expect(codeOf(() => json.buildGraph())).toBe('graph.optionsFrom.type');

    const rel = new ObjectRegistry({});
    rel.register({ name: 'customer', fields: [{ name: 'id', type: 'string', primary: true }] });
    rel.register({ name: 'order', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'customer_id', type: 'relation', target: 'customer' }] });
    rel.register({ name: 'invoice', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'v', type: 'enum', options: { from: { object: 'order', column: 'customer_id' } } }] });
    expect(codeOf(() => rel.buildGraph())).toBe('graph.optionsFrom.type');

    const arr = new ObjectRegistry({});
    arr.register({ name: 'tagset', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'tags', type: 'enum', multiple: true, options: ['a', 'b'] }] });
    arr.register(invoice({ name: 'v', type: 'enum', options: { from: { object: 'tagset', column: 'tags' } } }));
    expect(codeOf(() => arr.buildGraph())).toBe('graph.optionsFrom.type');
  });
});

describe('enum options.from — runtime membership', () => {
  function registryWith(currencyCol = 'code') {
    const registry = new ObjectRegistry({});
    const col = currencyCol === 'code' ? { name: 'code', type: 'string', primary: true } : { name: 'n', type: 'integer', primary: true };
    registry.register({ name: 'currency', fields: [col, { name: 'name', type: 'string' }] });
    const ccyField =
      currencyCol === 'code'
        ? { name: 'ccy', type: 'enum', options: { from: { object: 'currency', column: 'code' } } }
        : { name: 'ccy', type: 'enum', options: { from: { object: 'currency', column: 'n' } } };
    const def = registry.register(invoice(ccyField)!);
    registry.buildGraph();
    return { registry, def };
  }

  it('enforces membership for single-value dynamic enum', async () => {
    const { registry, def } = registryWith();
    await validateRecord(def, { id: '1', ccy: 'USD' }, WRITE_MODES.CREATE, {
      pool: lookupPool(['USD', 'EUR']) as never,
      registry,
      locale: 'en',
    });

    let caught: SchemaError | undefined;
    try {
      await validateRecord(def, { id: '1', ccy: 'ZZZ' }, WRITE_MODES.CREATE, {
        pool: lookupPool(['USD', 'EUR']) as never,
        registry,
        locale: 'en',
      });
    } catch (error) {
      caught = error instanceof SchemaError ? error : undefined;
    }
    expect(caught?.code).toBe('data.field.optionsFrom');
  });

  it('enforces membership element-wise for a multi-value dynamic enum', async () => {
    const registry = new ObjectRegistry({});
    registry.register({ name: 'tag', fields: [{ name: 'code', type: 'string', primary: true }] });
    const def = registry.register(
      invoice({ name: 'tags', type: 'enum', multiple: true, options: { from: { object: 'tag', column: 'code' } } })!,
    );
    registry.buildGraph();

    await validateRecord(def, { id: '1', tags: ['a', 'b'] }, WRITE_MODES.CREATE, {
      pool: lookupPool(['a', 'b', 'c']) as never,
      registry,
      locale: 'en',
    });

    let caught: SchemaError | undefined;
    try {
      await validateRecord(def, { id: '1', tags: ['a', 'ghost'] }, WRITE_MODES.CREATE, {
        pool: lookupPool(['a', 'b', 'c']) as never,
        registry,
        locale: 'en',
      });
    } catch (error) {
      caught = error instanceof SchemaError ? error : undefined;
    }
    expect(caught?.code).toBe('data.field.optionsFrom');
  });

  it('matches a numeric source column by its string form', async () => {
    const { registry, def } = registryWith('n');
    // allowed integer values 1..3, addressed as their string forms
    await validateRecord(def, { id: '1', ccy: '2' }, WRITE_MODES.CREATE, {
      pool: lookupPool(['1', '2', '3']) as never,
      registry,
      locale: 'en',
    });

    let caught: SchemaError | undefined;
    try {
      await validateRecord(def, { id: '1', ccy: '9' }, WRITE_MODES.CREATE, {
        pool: lookupPool(['1', '2', '3']) as never,
        registry,
        locale: 'en',
      });
    } catch (error) {
      caught = error instanceof SchemaError ? error : undefined;
    }
    expect(caught?.code).toBe('data.field.optionsFrom');
  });
});

describe('enum options.from — generated metadata', () => {
  it('describe exposes optionsFrom (M1); gen-types/OpenAPI fall back to string', () => {
    const registry = new ObjectRegistry({});
    registry.register({ name: 'currency', fields: [{ name: 'code', type: 'string', primary: true }] });
    const def = registry.register({
      name: 'invoice',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'ccy', type: 'enum', options: { from: { object: 'currency', column: 'code' } } },
      ],
      permissions: { admin: { read: 'all' } },
    });
    registry.buildGraph();

    const described = describeObject(registry, 'invoice', ['admin'], 'en');
    const ccy = described.fields.find((f) => f.name === 'ccy')!;
    expect(ccy.options).toBeUndefined();
    expect(ccy.optionsFrom).toEqual({ object: 'currency', column: 'code' });

    const ts = generateObjectTypes([def], registry.fieldTypes);
    expect(ts).toContain('ccy?: string;');

    const schema = fieldSchema(def.fields[1]!, new Map([['invoice', def]]), registry.fieldTypes);
    expect(schema).toMatchObject({ type: 'string' });
    expect(schema.enum).toBeUndefined();
  });
});
