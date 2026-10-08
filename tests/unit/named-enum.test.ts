import { describe, it, expect } from '../helpers/test.js';
import {
  buildEnumRegistry,
  describeObject,
  generateObjectTypes,
  ObjectRegistry,
  parseSchema,
  validateEnumDefinition,
  validateObject,
} from '../../src/core/index.js';

/** run a thunk and return the SchemaError code it threw (or undefined) */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const INVOICE_STATUS = {
  name: 'invoice_status',
  values: ['open', 'paid', 'void'],
  labels: {
    en: { open: 'Open', paid: 'Paid', void: 'Void' },
    zh: { open: '未结', paid: '已付', void: '作废' },
  },
};

const enums = buildEnumRegistry([validateEnumDefinition(INVOICE_STATUS)]);

function invoice(field: Record<string, unknown>): unknown {
  return { name: 'invoice', fields: [{ name: 'id', type: 'string', primary: true }, field] };
}

function fieldOf(def: { fields: unknown[] }, name: string): Record<string, unknown> {
  return def.fields.find((f) => (f as { name: string }).name === name) as Record<string, unknown>;
}

describe('named enum — declaration validation', () => {
  it('accepts a valid declaration with per-value labels', () => {
    const def = validateEnumDefinition(INVOICE_STATUS);
    expect(def.name).toBe('invoice_status');
    expect(def.values).toEqual(['open', 'paid', 'void']);
    expect(def.labels?.en?.paid).toBe('Paid');
    expect(def.labels?.zh?.void).toBe('作废');
  });

  it('drops an empty labels map', () => {
    const def = validateEnumDefinition({ name: 'some_enum', values: ['a'], labels: {} });
    expect(def.labels).toBeUndefined();
  });

  it('rejects structural errors with enum.invalid', () => {
    expect(codeOf(() => validateEnumDefinition(null))).toBe('enum.invalid');
    expect(codeOf(() => validateEnumDefinition({ name: 'Bad-Name', values: ['a'] }))).toBe('enum.invalid');
    expect(codeOf(() => validateEnumDefinition({ name: 'ok', values: [] }))).toBe('enum.invalid');
    expect(codeOf(() => validateEnumDefinition({ name: 'ok', values: ['a', 'a'] }))).toBe('enum.invalid');
    expect(codeOf(() => validateEnumDefinition({ name: 'ok', values: ['a'], labels: { en: { b: 'B' } } }))).toBe('enum.invalid');
    expect(codeOf(() => validateEnumDefinition({ name: 'ok', values: ['a'], labels: { 'not a tag!': { a: 'A' } } }))).toBe('enum.invalid');
  });
});

describe('named enum — field four states (schema v6)', () => {
  it('state 1: inline options derive `<object>_<field>` (regression)', () => {
    const def = validateObject(invoice({ name: 'status', type: 'enum', options: ['a', 'b'] }));
    expect(fieldOf(def, 'status').enumType).toBe('invoice_status');
    expect(fieldOf(def, 'status').options).toEqual(['a', 'b']);
  });

  it('state 2: inline options + explicit enumType not declared (regression)', () => {
    const def = validateObject(invoice({ name: 'status', type: 'enum', options: ['a'], enumType: 'custom_status' }));
    expect(fieldOf(def, 'status').enumType).toBe('custom_status');
  });

  it('state 3: named reference resolves values from the declaration', () => {
    const def = validateObject(invoice({ name: 'status', type: 'enum', enumType: 'invoice_status' }), { enums });
    expect(fieldOf(def, 'status').enumType).toBe('invoice_status');
    expect(fieldOf(def, 'status').options).toEqual(['open', 'paid', 'void']);
  });

  it('state 2 declared: inline options matching the declaration normalize to declared order', () => {
    const def = validateObject(
      invoice({ name: 'status', type: 'enum', options: ['void', 'paid', 'open'], enumType: 'invoice_status' }),
      { enums },
    );
    expect(fieldOf(def, 'status').options).toEqual(['open', 'paid', 'void']);
  });

  it('rejects inline options that do not match the declaration', () => {
    expect(
      codeOf(() => validateObject(invoice({ name: 'status', type: 'enum', options: ['open'], enumType: 'invoice_status' }), { enums })),
    ).toBe('enum.options.mismatch');
  });

  it('rejects an unresolved enumType reference', () => {
    expect(codeOf(() => validateObject(invoice({ name: 'status', type: 'enum', enumType: 'missing_status' }), { enums }))).toBe('enum.unknown');
    // no registry at all -> the reference cannot resolve either
    expect(codeOf(() => validateObject(invoice({ name: 'status', type: 'enum', enumType: 'invoice_status' })))).toBe('enum.unknown');
  });

  it('rejects an enum with neither options nor enumType', () => {
    expect(codeOf(() => validateObject(invoice({ name: 'status', type: 'enum' })))).toBe('field.enum.options.required');
  });

  it('state 4: data-driven { from } is unchanged', () => {
    const def = validateObject(invoice({ name: 'status', type: 'enum', options: { from: { object: 'invoice' } } }));
    expect(fieldOf(def, 'status').options).toEqual({ from: { object: 'invoice' } });
    expect(fieldOf(def, 'status').enumType).toBeUndefined();
  });

  it('rejects a named enum combined with a data-driven source', () => {
    expect(
      codeOf(() =>
        validateObject(invoice({ name: 'status', type: 'enum', enumType: 'invoice_status', options: { from: { object: 'invoice' } } }), { enums }),
      ),
    ).toBe('enum.options.mismatch');
  });

  it('validates `default` against the declared values', () => {
    const ok = validateObject(invoice({ name: 'status', type: 'enum', enumType: 'invoice_status', default: 'paid' }), { enums });
    expect(fieldOf(ok, 'status').default).toBe('paid');
    expect(
      codeOf(() => validateObject(invoice({ name: 'status', type: 'enum', enumType: 'invoice_status', default: 'nope' }), { enums })),
    ).toBe('field.default.inOptions');
  });

  it('resolves a named reference through parseSchema (JSON path)', () => {
    const def = parseSchema(
      JSON.stringify({ name: 'invoice', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'status', type: 'enum', enumType: 'invoice_status' }] }),
      { enums },
    );
    expect(fieldOf(def, 'status').options).toEqual(['open', 'paid', 'void']);
  });
});

describe('named enum — generated TS types', () => {
  it('emits one shared union and references it from every object', () => {
    const a = validateObject(invoice({ name: 'status', type: 'enum', enumType: 'invoice_status' }), { enums });
    const b = validateObject(
      { name: 'payment', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'state', type: 'enum', enumType: 'invoice_status' }] },
      { enums },
    );
    const src = generateObjectTypes([a, b], undefined, enums);
    expect(src).toContain("export type InvoiceStatus = 'open' | 'paid' | 'void';");
    expect(src).toContain('status?: InvoiceStatus;');
    expect(src).toContain('state?: InvoiceStatus;');
    // declared once, not per object
    expect(src.split('export type InvoiceStatus').length - 1).toBe(1);
  });

  it('keeps inline enums as inline unions', () => {
    const def = validateObject(invoice({ name: 'status', type: 'enum', options: ['a', 'b'] }));
    const src = generateObjectTypes([def]);
    expect(src).toContain("status?: 'a' | 'b';");
    expect(src).not.toContain('export type');
  });
});

describe('named enum — metadata contract', () => {
  it('describe surfaces the enum ref, resolved options and per-value labels', () => {
    const registry = new ObjectRegistry({ enums });
    registry.register({
      name: 'invoice',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'status', type: 'enum', enumType: 'invoice_status' },
      ],
      permissions: { admin: { read: 'all', create: true, update: true, delete: true } },
    });
    const descriptor = describeObject(registry, 'invoice', ['admin'], 'en');
    const status = fieldOf(descriptor as unknown as { fields: unknown[] }, 'status');
    expect(status.enum).toBe('invoice_status');
    expect(status.options).toEqual(['open', 'paid', 'void']);
    expect((status.optionLabels as Record<string, Record<string, string>>)?.en?.open).toBe('Open');
  });

  it('ObjectRegistry carries the enum registry into register()', () => {
    const registry = new ObjectRegistry({ enums });
    const def = registry.register({
      name: 'invoice',
      fields: [{ name: 'id', type: 'string', primary: true }, { name: 'status', type: 'enum', enumType: 'invoice_status' }],
    });
    expect(fieldOf(def, 'status').options).toEqual(['open', 'paid', 'void']);
  });
});
