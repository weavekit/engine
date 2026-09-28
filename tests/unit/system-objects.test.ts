import { describe, it, expect } from '../helpers/test.js';
import { buildExpectedTable, parseSchema, validateObject } from '../../src/core/index.js';
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

  it('carries identity-source columns + a composite unique + additive-alter opt-in', () => {
    for (const def of systemObjects()) {
      const names = def.fields.map((f) => f.name);
      expect(names).toEqual(expect.arrayContaining(['external_source', 'external_id']));
      expect(def.constraints).toEqual([{ type: 'unique', fields: ['external_source', 'external_id'] }]);
      expect(def.alter).toBe(true);
    }
    const user = systemObjects().find((d) => d.name === 'weavekit_user')!;
    expect(user.fields.find((f) => f.name === 'roles')?.type).toBe(FIELD_TYPES.JSONB);
  });

  it('buildExpectedTable emits the identity columns + composite UNIQUE', () => {
    const defs = new Map(systemObjects().map((d) => [d.name, d]));
    const user = defs.get('weavekit_user')!;
    const t = buildExpectedTable(user, defs);
    const byName = new Map(t.columns.map((c) => [c.name, c]));
    expect(byName.get('external_source')?.type).toBe('VARCHAR(255)');
    expect(byName.get('roles')?.type).toBe('JSONB');
    expect(t.uniques).toContainEqual({
      name: 'weavekit_user_external_source_external_id_key',
      columns: ['external_source', 'external_id'],
    });
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
