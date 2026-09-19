import { describe, it, expect } from '../helpers/test.js';
import {
  DEFAULT_LOCALE,
  ObjectRegistry,
  READ_SCOPES,
  ROW_SCOPE_MARKERS,
  SchemaError,
  describeObject,
  listObjectDescriptors,
  listObjectPermissions,
} from '../../src/index.js';

const registry = new ObjectRegistry();
registry.register({
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string', required: true },
    { name: 'status', type: 'enum', options: ['open', 'won', 'lost'], multiple: true },
    { name: 'category_id', type: 'relation', target: 'category' },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['name'], delete: true, fields: { exclude: ['secret'] } },
  },
  titleTemplate: '{name}',
});
registry.register({ name: 'category', fields: [{ name: 'id', type: 'string', primary: true }] });
registry.buildGraph();

const ghost = ['ghost_role'];
const sales = ['sales'];

describe('describeObject — single-object schema + effective permissions (M11 shared metadata)', () => {
  it('fields described by type semantics (enum options/multiple, relation target), excluded fields stripped', () => {
    const desc = describeObject(registry, 'lead', sales, DEFAULT_LOCALE);
    expect(desc.name).toBe('lead');
    expect(desc.titleTemplate).toBe('{name}');

    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    expect(byName.get('id')).toMatchObject({ name: 'id', type: 'string', primary: true });
    expect(byName.get('name')).toMatchObject({ name: 'name', type: 'string', required: true });
    expect(byName.get('status')).toMatchObject({ name: 'status', type: 'enum', options: ['open', 'won', 'lost'], multiple: true });
    expect(byName.get('category_id')).toMatchObject({ name: 'category_id', type: 'relation', target: 'category' });
    // excluded field is stripped from fields but listed in permissions.excludedFields
    expect(byName.has('secret')).toBe(false);
    expect(desc.permissions.excludedFields).toEqual(['secret']);

    expect(desc.relations).toEqual([{ field: 'category_id', type: 'relation', target: 'category' }]);
  });

  it('permissions shape = ResolvedPermission mapping (read/create/update/delete/excludedFields)', () => {
    const desc = describeObject(registry, 'lead', sales, DEFAULT_LOCALE);
    expect(desc.permissions).toEqual({
      read: READ_SCOPES.OWN,
      create: true,
      update: ['name'],
      delete: true,
      excludedFields: ['secret'],
      createFields: null,
    });
  });

  it('system/formula fields output readOnly (M11, SU-4 form read-only signal)', () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'invoice',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'subtotal', type: 'number', formula: '1 + 1' },
        { name: 'owner', type: 'string', system: true },
      ],
    });
    reg.buildGraph();
    const desc = describeObject(reg, 'invoice', ['any'], DEFAULT_LOCALE);
    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    expect(byName.get('subtotal')?.readOnly).toBe(true); // formula
    expect(byName.get('owner')?.readOnly).toBe(true); // system
    expect(byName.get('id')?.readOnly).toBeUndefined(); // ordinary field
  });

  it('unknown object → data.objectUnknown; no read permission → rbac.denied.read', () => {
    let unknown: string | undefined;
    try {
      describeObject(registry, 'nope', sales, DEFAULT_LOCALE);
    } catch (error) {
      unknown = error instanceof SchemaError ? error.code : undefined;
    }
    expect(unknown).toBe('data.objectUnknown');

    let denied: string | undefined;
    try {
      describeObject(registry, 'lead', ghost, DEFAULT_LOCALE);
    } catch (error) {
      denied = error instanceof SchemaError ? error.code : undefined;
    }
    expect(denied).toBe('rbac.denied.read');
  });
});

describe('listObjectDescriptors — read-only objects (menu/list baseline)', () => {
  it('sales sees lead + open object category; unlisted roles see only open objects', () => {
    const names = listObjectDescriptors(registry, sales).map((o) => o.name);
    expect(names).toContain('lead');
    expect(names).toContain('category'); // no permissions declared = open object, readable by everyone

    // ghost_role undeclared: lead invisible, open object category still visible
    expect(listObjectDescriptors(registry, ghost).map((o) => o.name)).toEqual(['category']);
  });
});

describe('listObjectPermissions — effective permissions per object (accessControl data source)', () => {
  it('includes any object that resolves to permissions (including open objects); unlisted roles see only open objects', () => {
    const perms = listObjectPermissions(registry, sales);
    const lead = perms.find((p) => p.name === 'lead');
    expect(lead).toBeDefined();
    expect(lead!.permissions.delete).toBe(true);
    expect(perms.find((p) => p.name === 'category')).toBeDefined();

    expect(listObjectPermissions(registry, ghost).map((p) => p.name)).toEqual(['category']);
  });
});

describe('describeObject — person/image/department new-type metadata', () => {
  it('person exposes target and counts in relations; image exposes multiple; department counts in relations; person.department exposed', () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'employee',
      fields: [{ name: 'id', type: 'string', primary: true }],
    });
    reg.register({
      name: 'department',
      fields: [{ name: 'id', type: 'string', primary: true }],
    });
    reg.register({
      name: 'contact',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'manager_id', type: 'person', target: 'employee', department: 'dept_id' },
        { name: 'dept_id', type: 'department', target: 'department' },
        { name: 'avatar', type: 'image' },
        { name: 'gallery', type: 'image', multiple: true },
      ],
    });
    reg.buildGraph();

    const desc = describeObject(reg, 'contact', ['any'], DEFAULT_LOCALE);
    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    expect(byName.get('manager_id')).toMatchObject({ name: 'manager_id', type: 'person', target: 'employee', department: 'dept_id' });
    expect(byName.get('dept_id')).toMatchObject({ name: 'dept_id', type: 'department', target: 'department' });
    expect(byName.get('avatar')).toMatchObject({ name: 'avatar', type: 'image' });
    expect(byName.get('avatar')?.multiple).toBe(false);
    expect(byName.get('gallery')?.multiple).toBe(true);
    expect(desc.relations).toContainEqual({ field: 'manager_id', type: 'person', target: 'employee' });
    expect(desc.relations).toContainEqual({ field: 'dept_id', type: 'department', target: 'department' });
  });
});
