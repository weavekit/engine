import { describe, it, expect } from '../helpers/test.js';
import {
  DEFAULT_LOCALE,
  ObjectRegistry,
  READ_SCOPES,
  ROW_SCOPE_MARKERS,
  SchemaError,
  buildFieldTypeRegistry,
  describeObject,
  listObjectDescriptors,
  listObjectPermissions,
} from '../../src/index.js';

const registry = new ObjectRegistry();
registry.register({
  name: 'lead',
  labels: { en: 'Lead' },
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string', required: true, labels: { en: 'Name' } },
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

describe('describeObject — single-object schema + effective permissions', () => {
  it('fields described by type semantics (enum options/multiple, relation target), excluded fields stripped', () => {
    const desc = describeObject(registry, 'lead', sales, DEFAULT_LOCALE);
    expect(desc.name).toBe('lead');
    expect(desc.labels).toEqual({ en: 'Lead' });
    expect(desc.titleTemplate).toBe('{name}');

    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    expect(byName.get('id')).toMatchObject({ name: 'id', type: 'string', primary: true });
    expect(byName.get('name')).toMatchObject({ name: 'name', type: 'string', required: true, labels: { en: 'Name' } });
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

  it('system/formula fields output readOnly (form read-only signal)', () => {
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

  it('exposes the resolved `base` for delegated/registered types; omits it for primitives', () => {
    const reg = new ObjectRegistry({
      fieldTypes: buildFieldTypeRegistry([{ name: 'acme_money', base: 'number' }]),
    });
    reg.register(
      {
        name: 'invoice',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'label', type: 'string' },
          { name: 'email', type: 'email' },
          { name: 'amount', type: 'acme_money' },
        ],
      },
      { fieldTypes: reg.fieldTypes },
    );
    reg.buildGraph();
    const byName = new Map(
      describeObject(reg, 'invoice', ['any'], DEFAULT_LOCALE).fields.map((f) => [f.name, f]),
    );
    // primitives carry no `base`
    expect(byName.get('id')?.base).toBeUndefined();
    expect(byName.get('label')?.base).toBeUndefined();
    // delegated built-in and registered types report their primitive
    expect(byName.get('email')?.base).toBe('string');
    expect(byName.get('amount')?.base).toBe('number');
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

describe('describeObject — virtual system fields (weave_*), read-only + typed', () => {
  it('appends weave_id + side-table metadata fields (virtual, read-only) after declared fields', () => {
    const desc = describeObject(registry, 'lead', sales, DEFAULT_LOCALE);
    const names = desc.fields.map((f) => f.name);
    // declared fields come first, virtual fields are appended
    expect(names.indexOf('weave_id')).toBeGreaterThan(names.indexOf('name'));

    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    expect(byName.get('weave_id')).toMatchObject({ name: 'weave_id', type: 'string', virtual: true, readOnly: true });
    expect(byName.get('weave_status')).toMatchObject({
      name: 'weave_status',
      type: 'enum',
      virtual: true,
      readOnly: true,
      options: ['draft', 'running', 'effective', 'canceled'],
    });
    expect(byName.get('weave_created_time')).toMatchObject({ type: 'timestamptz', virtual: true, readOnly: true });
    // virtual fields order is stable and starts with weave_id
    expect(desc.fields.filter((f) => f.virtual === true).map((f) => f.name)).toEqual([
      'weave_id',
      'weave_status',
      'weave_owner_id',
      'weave_created_by',
      'weave_modified_by',
      'weave_created_time',
      'weave_modified_time',
      'weave_workflow_id',
    ]);
  });
});

describe('describeObject — user/department/image new-type metadata', () => {
  it('user exposes the identity target + department column; image exposes multiple; department counts in relations', () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'contact',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'manager_id', type: 'user' },
        { name: 'dept_id', type: 'department' },
        { name: 'avatar', type: 'image' },
        { name: 'gallery', type: 'image', multiple: true },
      ],
    });
    reg.buildGraph();

    const desc = describeObject(reg, 'contact', ['any'], DEFAULT_LOCALE);
    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    expect(byName.get('manager_id')).toMatchObject({ name: 'manager_id', type: 'user', target: 'weavekit_user', department: 'department_id' });
    expect(byName.get('dept_id')).toMatchObject({ name: 'dept_id', type: 'department', target: 'weavekit_department' });
    expect(byName.get('avatar')).toMatchObject({ name: 'avatar', type: 'image' });
    expect(byName.get('avatar')?.multiple).toBe(false);
    expect(byName.get('gallery')?.multiple).toBe(true);
    expect(desc.relations).toContainEqual({ field: 'manager_id', type: 'user', target: 'weavekit_user' });
    expect(desc.relations).toContainEqual({ field: 'dept_id', type: 'department', target: 'weavekit_department' });
  });
});

describe('describeObject — currency code', () => {
  it('exposes the ISO code; omits it when absent', () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'invoice',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'amount_jpy', type: 'currency', currency: 'JPY' },
        { name: 'amount', type: 'currency' },
      ],
    });
    const desc = describeObject(reg, 'invoice', ['any'], DEFAULT_LOCALE);
    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    expect(byName.get('amount_jpy')?.currency).toBe('JPY');
    expect(byName.get('amount')?.currency).toBeUndefined();
  });
});

describe('describeObject — row-scope field markers', () => {
  it('marks the ownership/department columns and their id source', () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'widget',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'owner_ref', type: 'string', ownership: true, ownershipSource: 'external' },
        { name: 'dept_id', type: 'string', department: true },
      ],
      permissions: { viewer: { read: 'department', manage: 'own' } },
    });
    reg.buildGraph();
    const desc = describeObject(reg, 'widget', ['viewer'], DEFAULT_LOCALE);
    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    expect(byName.get('owner_ref')).toMatchObject({ ownership: true, scopeSource: 'external' });
    expect(byName.get('dept_id')).toMatchObject({ departmentScope: true, scopeSource: 'internal' });
    // read/manage scopes are both surfaced
    expect(desc.permissions.read).toBe(READ_SCOPES.DEPARTMENT);
    expect(desc.permissions.manage).toBe(READ_SCOPES.OWN);
  });
});
