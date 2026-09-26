import { describe, it, expect } from '../helpers/test.js';
import { parseSchema, validateObject } from '../../src/core/index.js';
import { systemObjects, SYSTEM_OBJECT_NAMES } from '../../src/core/object/system-objects.js';
import { FIELD_TYPES } from '../../src/core/types/values.js';

describe('built-in identity objects', () => {
  it('exposes the reserved names', () => {
    expect([...SYSTEM_OBJECT_NAMES]).toEqual(['weavekit_user', 'weavekit_department']);
    expect(systemObjects().map((d) => d.name).sort()).toEqual([
      'weavekit_department',
      'weavekit_user',
    ]);
  });

  it('uses an application-generated uuid primary key', () => {
    for (const def of systemObjects()) {
      const id = def.fields.find((f) => f.name === 'id');
      expect(id?.primary).toBe(true);
      expect(id?.type).toBe(FIELD_TYPES.UUID);
      expect((id as { required?: boolean }).required).toBe(true);
    }
  });

  it('models the user/department relation fields', () => {
    const user = systemObjects().find((d) => d.name === 'weavekit_user')!;
    const dept = systemObjects().find((d) => d.name === 'weavekit_department')!;
    expect(JSON.stringify(user.fields.find((f) => f.name === 'department_id'))).toContain(
      'weavekit_department',
    );
    expect(JSON.stringify(user.fields.find((f) => f.name === 'manager_id'))).toContain('weavekit_user');
    expect(JSON.stringify(dept.fields.find((f) => f.name === 'manager_id'))).toContain('weavekit_user');
  });
});

describe('reserved object-name guard', () => {
  it('rejects user objects under the reserved prefix', () => {
    expect(() =>
      validateObject({ name: 'weavekit_foo', fields: [{ name: 'id', type: 'string', primary: true }] }),
    ).toThrow();
  });

  it('rejects a reserved name through parseSchema', () => {
    expect(() =>
      parseSchema(JSON.stringify({ name: 'weavekit_record__x', fields: [{ name: 'id', type: 'string', primary: true }] })),
    ).toThrow();
  });

  it('still allows ordinary names', () => {
    expect(
      validateObject({ name: 'orders', fields: [{ name: 'id', type: 'string', primary: true }] }).name,
    ).toBe('orders');
  });
});
