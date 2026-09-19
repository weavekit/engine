import { describe, it, expect } from '../helpers/test.js';import { defineObject, ObjectRegistry, SchemaError, primaryKeyOf } from '../../src/core/index.js';

describe('ObjectRegistry', () => {
  it('register/read/list', () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'a', fields: [{ name: 'id', type: 'string', primary: true }] });
    reg.register({ name: 'b', fields: [{ name: 'id', type: 'string', primary: true }] });

    expect(reg.get('a')?.name).toBe('a');
    expect(reg.get('ghost')).toBeUndefined();
    expect(reg.list().map((d) => d.name)).toEqual(['a', 'b']);
  });

  it('duplicate registration rejected', () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'a', fields: [{ name: 'id', type: 'string', primary: true }] });
    expect(() =>
      reg.register({ name: 'a', fields: [{ name: 'id', type: 'string', primary: true }] }),
    ).toThrow(SchemaError);
  });
});

describe('defineObject — programmatic API', () => {
  it('returns valid object definition', () => {
    const def = defineObject({
      name: 'lead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string', required: true },
      ],
    });
    expect(def.name).toBe('lead');
    expect(primaryKeyOf(def)).toBe('id');
    expect(def.fields).toHaveLength(2);
  });

  it('invalid input throws SchemaError', () => {
    expect(() =>
      defineObject({ name: 'lead', fields: [{ name: 'id', type: 'string' }] }),
    ).toThrow(/must declare exactly one primary/);
  });
});
