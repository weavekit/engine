import { describe, it, expect } from '../helpers/test.js';
import {
  buildFieldTypeRegistry,
  ObjectRegistry,
  SchemaError,
  validateObject,
} from '../../src/core/index.js';
import { normalizeFieldTypeRegistration } from '../../src/runtime/fieldtypes/index.js';
import { pgType } from '../../src/core/storage/map.js';
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

/** a pool whose queries always report "no rows found" */
const emptyPool = { query: async () => ({ rows: [], rowCount: 0 }) };

function objectDef(extra: Record<string, unknown>): unknown {
  return {
    name: 'invoice',
    fields: [{ name: 'id', type: 'string', primary: true }, extra],
  };
}

describe('field-type custom storage (`storage.pgType`)', () => {
  const money = buildFieldTypeRegistry([
    {
      name: 'acme_money',
      base: 'number',
      attrs: { precision: { type: 'integer' } },
      storage: { pgType: (f) => `NUMERIC(${(f as { precision?: number }).precision ?? 12},2)` },
    },
  ]);

  it('overrides the column type, and declared attrs are preserved on the field', () => {
    const def = validateObject(objectDef({ name: 'amount', type: 'acme_money', precision: 10 }), { fieldTypes: money });
    const amount = def.fields.find((f) => f.name === 'amount')!;
    expect(amount.type).toBe('acme_money');
    expect((amount as unknown as { precision?: number }).precision).toBe(10);
    expect(pgType(amount, undefined, money)).toBe('NUMERIC(10,2)');
    expect(pgType(amount, undefined, money)).toContain('10,2');
  });

  it('falls back to the declared default when the attr is absent', () => {
    const def = validateObject(objectDef({ name: 'amount', type: 'acme_money' }), { fieldTypes: money });
    expect(pgType(def.fields.find((f) => f.name === 'amount')!, undefined, money)).toBe('NUMERIC(12,2)');
  });

  it('rejects a storage.pgType output that is not a safe PostgreSQL type', () => {
    const bad = buildFieldTypeRegistry([
      { name: 'acme_bad', base: 'string', storage: { pgType: () => 'DROP TABLE x' } },
    ]);
    const def = validateObject(objectDef({ name: 'a', type: 'acme_bad' }), { fieldTypes: bad });
    expect(codeOf(() => pgType(def.fields.find((f) => f.name === 'a')!, undefined, bad))).toBe(
      'fieldtype.storage.invalid',
    );
  });

  it('rejects storage on a relation-like base at load time', () => {
    expect(
      codeOf(() =>
        normalizeFieldTypeRegistration({
          namespace: 'acme',
          name: 'ref',
          base: 'relation',
          relationLike: true,
          storage: { pgType: () => 'TEXT' },
        }),
      ),
    ).toBe('fieldtype.invalid');
  });
});

describe('field-type typed attrs + inherited base validation', () => {
  const money = buildFieldTypeRegistry([
    { name: 'acme_money', base: 'number', attrs: { currency: { type: 'string', required: true } } },
  ]);

  it('required attr missing → field.attr.required', () => {
    expect(codeOf(() => validateObject(objectDef({ name: 'amount', type: 'acme_money' }), { fieldTypes: money }))).toBe(
      'field.attr.required',
    );
  });

  it('attr value of the wrong kind → field.attr.type', () => {
    expect(
      codeOf(() => validateObject(objectDef({ name: 'amount', type: 'acme_money', currency: 42 }), { fieldTypes: money })),
    ).toBe('field.attr.type');
  });

  it('valid attr + inherited base constraints (min) are accepted and preserved', () => {
    const def = validateObject(objectDef({ name: 'amount', type: 'acme_money', currency: 'USD', min: 0 }), {
      fieldTypes: money,
    });
    expect(def.fields.find((f) => f.name === 'amount')).toMatchObject({ currency: 'USD', min: 0 });
  });

  it('the base primitive value validation is enforced at write time', async () => {
    const def = validateObject(objectDef({ name: 'amount', type: 'acme_money', currency: 'USD', min: 0 }), {
      fieldTypes: money,
    });
    const registry = new ObjectRegistry({ fieldTypes: money });
    registry.register(def, { fieldTypes: money });
    let caught: SchemaError | undefined;
    try {
      await validateRecord(def, { id: '1', amount: -1 }, WRITE_MODES.CREATE, {
        pool: emptyPool as never,
        registry,
        locale: 'en',
      });
    } catch (error) {
      caught = error instanceof SchemaError ? error : undefined;
    }
    expect(caught?.code).toBe('data.field.min');
  });
});

describe('field-type `validate` hook (pure, sync)', () => {
  const even = buildFieldTypeRegistry([
    {
      name: 'acme_even',
      base: 'integer',
      validate: (_f, v) => (typeof v === 'number' && v % 2 !== 0 ? 'must be even' : undefined),
    },
  ]);

  const def = validateObject(objectDef({ name: 'n', type: 'acme_even' }), { fieldTypes: even });
  const registry = new ObjectRegistry({ fieldTypes: even });
  registry.register(def, { fieldTypes: even });

  it('rejects with data.field.custom when the hook returns a detail', async () => {
    let caught: SchemaError | undefined;
    try {
      await validateRecord(def, { id: '1', n: 3 }, WRITE_MODES.CREATE, {
        pool: emptyPool as never,
        registry,
        locale: 'en',
      });
    } catch (error) {
      caught = error instanceof SchemaError ? error : undefined;
    }
    expect(caught?.code).toBe('data.field.custom');
    expect(caught?.params.detail).toBe('must be even');
  });

  it('allows the value when the hook returns undefined', async () => {
    await validateRecord(def, { id: '1', n: 4 }, WRITE_MODES.CREATE, {
      pool: emptyPool as never,
      registry,
      locale: 'en',
    });
  });
});
