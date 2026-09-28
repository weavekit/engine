import { describe, it, expect } from '../helpers/test.js';
import {
  ObjectRegistry,
  buildRowScopeFor,
  resolvePermissionFor,
  validateObject,
  SchemaError,
} from '../../src/core/index.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('details child — permission inheritance (narrow, never broaden)', () => {
  const contacts = [
    { name: 'id', type: 'string', primary: true },
    { name: 'owner_id', type: 'string', ownership: true },
  ];

  function registryWith(): ObjectRegistry {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'order',
      fields: [...contacts, { name: 'lines', type: 'details', target: 'line' }],
      permissions: { sales: { read: 'department', create: true, update: true, delete: false } },
    });
    reg.register({ name: 'line', fields: contacts });
    reg.buildGraph();
    return reg;
  }

  it('a child with no permissions inherits the parent exactly', () => {
    const reg = registryWith();
    const child = reg.get('line')!;
    const parent = reg.get('order')!;
    const pParent = resolvePermissionFor(reg, parent, ['sales'])!;
    const pChild = resolvePermissionFor(reg, child, ['sales'])!;
    expect(pChild.read).toBe(pParent.read);
    expect(pChild.create).toBe(true);
    expect(pChild.delete).toBe(false);
  });

  it('a child may narrow (scope + operations intersect)', () => {
    const reg = registryWith();
    // narrow the child's own permission set in place (post-build)
    reg.get('line')!.permissions = { sales: { read: 'own', create: false, update: false } };
    const p = resolvePermissionFor(reg, reg.get('line')!, ['sales'])!;
    expect(p.read).toBe('own'); // narrower of department vs own
    expect(p.create).toBe(false); // parent true AND child false
    expect(p.delete).toBe(false);
  });

  it('a child declaring broader permissions than the parent is rejected', () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'order',
      fields: [...contacts, { name: 'lines', type: 'details', target: 'line' }],
      permissions: { sales: { read: 'own', create: true, delete: false } },
    });
    reg.register({
      name: 'line',
      fields: contacts,
      permissions: { sales: { read: 'all' } },
    });
    expect(codeOf(() => reg.buildGraph())).toBe('permission.detailsChild.broader');
  });

  it('a details child belongs to a single parent', () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'a', fields: [...contacts, { name: 'kids', type: 'details', target: 'kid' }] });
    reg.register({ name: 'b', fields: [...contacts, { name: 'kids', type: 'details', target: 'kid' }] });
    reg.register({ name: 'kid', fields: contacts });
    expect(codeOf(() => reg.buildGraph())).toBe('graph.details.multiParent');
  });

  it('row scope is derived from the parent via parent_id', () => {
    const reg = registryWith();
    const subject = { id: 'u1', roles: ['sales'], departmentId: 'd1' };
    const scope = buildRowScopeFor(reg, reg.get('line')!, 'department', subject, ['sales']);
    expect(scope).toBeDefined();
    expect(scope!.sql).toContain('weavekit_department');
    expect(scope!.sql).toContain('"parent_id"');
    expect(scope!.params).toEqual(['d1']);
  });
});

describe('details inheritance does not affect plain objects', () => {
  it('resolvePermissionFor equals resolvePermission without a details parent', () => {
    const def = validateObject({
      name: 'plain',
      fields: [{ name: 'id', type: 'string', primary: true }],
      permissions: { r: { read: 'all' } },
    });
    const reg = new ObjectRegistry();
    const p = resolvePermissionFor(reg, def, ['r']);
    expect(p?.read).toBe('all');
    expect(resolvePermissionFor(reg, def, ['nope'])).toBeUndefined();
  });
});

describe('SchemaError import sanity', () => {
  it('exposes SchemaError', () => {
    expect(SchemaError).toBeDefined();
  });
});
