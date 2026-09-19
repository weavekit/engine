import { describe, it, expect } from '../helpers/test.js';import { ObjectRegistry, validateObject } from '../../src/core/index.js';

describe('validateObject — formula fields', () => {
  it('valid formula (arithmetic/string/boolean)', () => {
    const def = validateObject({
      name: 'order',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'unit_price', type: 'currency' },
        { name: 'qty', type: 'integer' },
        { name: 'total', type: 'currency', formula: 'unit_price * qty' },
        { name: 'label', type: 'string', formula: "'Order-' & qty" },
        { name: 'big', type: 'boolean', formula: 'total >= 100' },
      ],
    });
    expect(def.fields[3]).toMatchObject({ name: 'total', formula: 'unit_price * qty' });
  });

  it('syntax errors rejected', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'a', type: 'number' },
          { name: 'b', type: 'number', formula: 'a +' },
        ],
      }),
    ).toThrow(/formula syntax error/);
  });

  it('excludes required/unique/default when formula present', () => {
    for (const attrs of [
      { required: true },
      { unique: true },
      { default: 1 },
    ]) {
      expect(() =>
        validateObject({
          name: 'order',
          fields: [
            { name: 'id', type: 'string', primary: true },
            { name: 'a', type: 'number' },
            { name: 'b', type: 'number', formula: 'a * 2', ...attrs },
          ],
        }),
      ).toThrow(/formula field cannot have/);
    }
  });

  it('excludes constraint attributes when formula present', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'a', type: 'number' },
          { name: 'b', type: 'number', formula: 'a * 2', min: 0 },
        ],
      }),
    ).toThrow(/formula field cannot have/);
  });

  it('enum/date/datetime disallow formula', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'a', type: 'number' },
          { name: 'b', type: 'enum', options: ['x', 'y'], formula: 'a' },
        ],
      }),
    ).toThrow(/does not allow attribute "formula"/);
  });

  it('formula cannot be primary', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'a', type: 'number' },
          { name: 'b', type: 'number', formula: 'a * 2', primary: true },
        ],
      }),
    ).toThrow(/formula field cannot have primary/);
  });

  it('reference to non-existent field rejected', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'b', type: 'number', formula: 'ghost * 2' },
        ],
      }),
    ).toThrow(/references missing field "ghost"/);
  });

  it('cannot reference relation field directly', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'customer_id', type: 'relation', target: 'customer' },
          { name: 'b', type: 'string', formula: 'customer_id' },
        ],
      }),
    ).toThrow(/cannot reference relation field "customer_id"/);
  });

  it('incompatible type rejected', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'a', type: 'number' },
          { name: 'b', type: 'boolean', formula: 'a * 2' },
        ],
      }),
    ).toThrow(/not compatible/);
  });

  it('wrong operand type rejected', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'a', type: 'string' },
          { name: 'b', type: 'number', formula: 'a * 2' },
        ],
      }),
    ).toThrow(/operator \* requires numeric operands/);
  });

  it('same-object formula cycle rejected', () => {
    expect(() =>
      validateObject({
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'a', type: 'number', formula: 'b + 1' },
          { name: 'b', type: 'number', formula: 'a + 1' },
        ],
      }),
    ).toThrow(/formula cycle detected/);
  });
});

describe('buildGraph — cross-object formula', () => {
  const reg = (entries: Record<string, unknown>) => {
    const r = new ObjectRegistry();
    for (const d of Object.values(entries)) r.register(d);
    return r;
  };

  it('cross-object reference to missing target field rejected', () => {
    const r = reg({
      supplier: {
        name: 'supplier',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'supplier_id', type: 'relation', target: 'supplier' },
          { name: 'region', type: 'string', formula: 'supplier_id.region' },
        ],
      },
    });
    expect(() => r.buildGraph()).toThrow(/references missing field "supplier_id.region"/);
  });

  it('aggregate reference to missing child field rejected', () => {
    const r = reg({
      line: {
        name: 'line',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'lines', type: 'details', target: 'line' },
          { name: 'total', type: 'currency', formula: 'SUM(lines.qty)' },
        ],
      },
    });
    expect(() => r.buildGraph()).toThrow(/on child "line"/);
  });

  it('cross-object formula cycle rejected', () => {
    const r = reg({
      supplier: {
        name: 'supplier',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'main_order_id', type: 'relation', target: 'order' },
          { name: 'rate', type: 'number', formula: 'main_order_id.some_val' },
        ],
      },
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'supplier_id', type: 'relation', target: 'supplier' },
          { name: 'some_val', type: 'number', formula: 'supplier_id.rate' },
        ],
      },
    });
    expect(() => r.buildGraph()).toThrow(/formula cycle detected/);
  });

  it('valid cross-object formula passes', () => {
    const r = reg({
      supplier: {
        name: 'supplier',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'region', type: 'string' },
        ],
      },
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'supplier_id', type: 'relation', target: 'supplier' },
          { name: 'region', type: 'string', formula: 'supplier_id.region' },
        ],
      },
    });
    expect(() => r.buildGraph()).not.toThrow();
  });
});
