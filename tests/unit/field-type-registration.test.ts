import { describe, it, expect } from '../helpers/test.js';
import {
  DEFAULT_FIELD_TYPE_REGISTRY,
  ObjectRegistry,
  buildFieldTypeRegistry,
  fieldBase,
  isRelationLike,
  isScalarFieldType,
  validateObject,
} from '../../src/core/index.js';
import { pgType } from '../../src/core/storage/map.js';
import { generateObjectTypes } from '../../src/core/object/gen-types.js';
import { describeObject } from '../../src/core/object/describe.js';
import { fieldSchema } from '../../src/adapters/openapi/schema.js';
import { normalizeFieldTypeRegistration } from '../../src/runtime/fieldtypes/index.js';

/** capture a thrown SchemaError code (undefined when nothing throws) */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const registry = buildFieldTypeRegistry([
  { name: 'acme_money', base: 'number' },
  { name: 'acme_ref', base: 'relation', relationLike: true },
  { name: 'acme_email', base: 'string', openApiFormat: 'email' },
]);

describe('field-type registry — base delegation', () => {
  it('built-ins resolve through the default registry', () => {
    expect(fieldBase(DEFAULT_FIELD_TYPE_REGISTRY, 'email')).toBe('string');
    expect(fieldBase(DEFAULT_FIELD_TYPE_REGISTRY, 'person')).toBe('relation');
    expect(isScalarFieldType(DEFAULT_FIELD_TYPE_REGISTRY, 'email')).toBe(true);
    expect(isRelationLike(DEFAULT_FIELD_TYPE_REGISTRY, 'person')).toBe(true);
  });

  it('registered types inherit their base', () => {
    expect(fieldBase(registry, 'acme_money')).toBe('number');
    expect(isRelationLike(registry, 'acme_ref')).toBe(true);
    expect(isScalarFieldType(registry, 'acme_money')).toBe(true);
  });

  it('building an extended registry never mutates the default', () => {
    expect(DEFAULT_FIELD_TYPE_REGISTRY.get('acme_money')).toBeUndefined();
  });
});

describe('normalizeFieldTypeRegistration', () => {
  it('auto-applies the namespace prefix (idempotent)', () => {
    expect(normalizeFieldTypeRegistration({ namespace: 'acme', name: 'money', base: 'number' }).name).toBe('acme_money');
    expect(normalizeFieldTypeRegistration({ name: 'acme_money', base: 'number' }).name).toBe('acme_money');
  });

  it('rejects a non-namespaced name', () => {
    expect(codeOf(() => normalizeFieldTypeRegistration({ name: 'money', base: 'number' }))).toBe('fieldtype.name.invalid');
  });

  it('rejects a structural base', () => {
    expect(codeOf(() => normalizeFieldTypeRegistration({ name: 'acme_x', base: 'details' }))).toBe('fieldtype.base.invalid');
  });
});

describe('validateObject — registered types', () => {
  const schema = {
    name: 'invoice',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'amount', type: 'acme_money' },
      { name: 'contact', type: 'acme_email' },
      { name: 'customer_id', type: 'acme_ref', target: 'customer' },
    ],
    permissions: { admin: { read: 'all', create: true, update: true, delete: true } },
  };

  it('accepts registered types when the registration is present', () => {
    const def = validateObject(schema, { fieldTypes: registry });
    expect(def.fields.find((f) => f.name === 'amount')?.type).toBe('acme_money');
  });

  it('a namespaced-but-unregistered type is field.type.unknown', () => {
    expect(codeOf(() => validateObject(schema, { fieldTypes: DEFAULT_FIELD_TYPE_REGISTRY }))).toBe('field.type.unknown');
  });

  it('a bare unknown type stays field.type.invalid', () => {
    const bad = { name: 'x', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'a', type: 'magic' }] };
    expect(codeOf(() => validateObject(bad))).toBe('field.type.invalid');
  });

  it('respects the features.fieldTypes whitelist', () => {
    expect(codeOf(() => validateObject(schema, { fieldTypes: registry, allowedFieldTypes: ['string', 'number'] }))).toBe(
      'field.type.disabled',
    );
  });

  it('a registered scalar type can be the primary key', () => {
    const pkReg = buildFieldTypeRegistry([{ name: 'acme_key', base: 'string' }]);
    const def = validateObject({ name: 'x', fields: [{ name: 'id', type: 'acme_key', primary: true }] }, { fieldTypes: pkReg });
    expect(def.fields[0]?.primary).toBe(true);
  });
});

describe('registered types flow through consumers', () => {
  const def = validateObject(
    {
      name: 'invoice',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'amount', type: 'acme_money' },
        { name: 'contact', type: 'acme_email' },
        { name: 'customer_id', type: 'acme_ref', target: 'customer' },
      ],
      permissions: { admin: { read: 'all', create: true, update: true, delete: true } },
    },
    { fieldTypes: registry },
  );
  const field = (name: string) => def.fields.find((f) => f.name === name)!;

  it('storage maps by base', () => {
    expect(pgType(field('amount'), undefined, registry)).toBe('NUMERIC');
    expect(pgType(field('contact'), undefined, registry)).toBe('VARCHAR(255)');
    expect(pgType(field('customer_id'), 'VARCHAR(255)', registry)).toBe('VARCHAR(255)');
  });

  it('gen-types maps by base', () => {
    const ts = generateObjectTypes([def], registry);
    expect(ts).toContain('amount?: number;');
    expect(ts).toContain('contact?: string;');
  });

  it('describe surfaces the relation target', () => {
    const objects = new ObjectRegistry({ fieldTypes: registry });
    objects.register(def, { fieldTypes: registry });
    const described = describeObject(objects, 'invoice', ['admin'], 'en');
    expect(described.relations.find((r) => r.field === 'customer_id')?.target).toBe('customer');
  });

  it('describe surfaces declared attrs with their spec', () => {
    const withAttrs = buildFieldTypeRegistry([
      {
        name: 'acme_money',
        base: 'number',
        attrs: {
          scale: { type: 'integer', default: 2, description: 'decimal places' },
          currency: { type: 'enum', values: ['USD', 'EUR'], required: true },
        },
      },
    ]);
    const attrsDef = validateObject(
      {
        name: 'invoice',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'amount', type: 'acme_money', scale: 3, currency: 'USD' },
          { name: 'deposit', type: 'acme_money', currency: 'EUR' },
        ],
        permissions: { admin: { read: 'all', create: true, update: true, delete: true } },
      },
      { fieldTypes: withAttrs },
    );
    const objects = new ObjectRegistry({ fieldTypes: withAttrs });
    objects.register(attrsDef, { fieldTypes: withAttrs });
    const described = describeObject(objects, 'invoice', ['admin'], 'en');
    const field = (name: string) => described.fields.find((f) => f.name === name)!;

    expect(field('amount').attrs).toEqual({
      scale: { value: 3, type: 'integer', default: 2, description: 'decimal places' },
      currency: { value: 'USD', type: 'enum', values: ['USD', 'EUR'] },
    });
    // an optional attr left unset still surfaces its spec, without a value
    expect(field('deposit').attrs).toEqual({
      scale: { type: 'integer', default: 2, description: 'decimal places' },
      currency: { value: 'EUR', type: 'enum', values: ['USD', 'EUR'] },
    });
    // plain built-in fields carry no attrs
    expect(field('id').attrs).toBeUndefined();
  });

  it('openapi schema maps by base + format hint', () => {
    const objects = new Map([[def.name, def]]);
    expect(fieldSchema(field('amount'), objects, registry)).toMatchObject({ type: 'number' });
    expect(fieldSchema(field('contact'), objects, registry)).toMatchObject({ type: 'string', format: 'email' });
  });
});
