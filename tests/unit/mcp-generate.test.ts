import { describe, it, expect } from '../helpers/test.js';import { ObjectRegistry } from '../../src/core/object/registry.js';
import { compileToolsFor, fieldValueSchema } from '../../src/adapters/mcp/generate.js';
import type { McpEngine } from '../../src/adapters/mcp/types.js';
import type { ObjectDefinition, RbacSubject } from '../../src/core/index.js';

const SUPPLIER: ObjectDefinition = {
  name: 'supplier',
  fields: [{ name: 'id', type: 'string', primary: true }],
};

const TAG: ObjectDefinition = {
  name: 'tag',
  fields: [{ name: 'id', type: 'integer', primary: true }],
};

const LEAD: ObjectDefinition = {
  name: 'lead',
  labels: { en: 'Lead' },
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string', required: true },
    { name: 'note', type: 'text' },
    { name: 'count', type: 'integer' },
    { name: 'amount', type: 'currency' },
    { name: 'active', type: 'boolean' },
    { name: 'created_at', type: 'datetime' },
    { name: 'due_date', type: 'date' },
    { name: 'meta', type: 'json' },
    { name: 'status', type: 'enum', options: ['open', 'won', 'archived'] },
    { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true },
    { name: 'supplier_id', type: 'relation', target: 'supplier' },
    { name: 'tag_ids', type: 'multiRelation', target: 'tag' },
    { name: 'secret', type: 'string' },
    { name: 'owner_id', type: 'string', ownership: true },
    { name: 'seq', type: 'seq_no', format: '{seq}' },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['title', 'status'], delete: true, fields: { exclude: ['secret'] } },
    finance: { read: 'all', fields: { exclude: ['secret'] } },
  },
};

function engineFor(defs: ObjectDefinition[], subject: RbacSubject): { engine: McpEngine; names: string[] } {
  const registry = new ObjectRegistry();
  for (const def of defs) registry.register(def);
  registry.buildGraph();
  const engine: McpEngine = {
    registry,
    pool: {} as never,
    dataAccess: {} as never,
    locale: 'en',
  };
  return { engine, names: compileToolsFor(engine, subject).map((t) => t.spec.name) };
}

describe('compileToolsFor — permission-driven tool surface', () => {
  it('sales: full CRUD on lead + introspection', () => {
    const { names } = engineFor([SUPPLIER, TAG, LEAD], { id: 'u1', roles: ['sales'] });
    expect(names).toContain('search_lead');
    expect(names).toContain('get_lead');
    expect(names).toContain('create_lead');
    expect(names).toContain('update_lead');
    expect(names).toContain('delete_lead');
    expect(names).toContain('list_objects');
    expect(names).toContain('describe_object');
  });

  it('finance (read only): search/get only, no create/update/delete', () => {
    const { names } = engineFor([SUPPLIER, TAG, LEAD], { id: 'u2', roles: ['finance'] });
    expect(names).toContain('search_lead');
    expect(names).toContain('get_lead');
    expect(names).not.toContain('create_lead');
    expect(names).not.toContain('update_lead');
    expect(names).not.toContain('delete_lead');
  });

  it('role not listed on an object → object invisible (zero tools)', () => {
    const { names } = engineFor([SUPPLIER, TAG, LEAD], { id: 'u3', roles: ['ghost'] });
    expect(names).not.toContain('search_lead');
    // open-mode objects (no permissions map) are still visible to any role
    expect(names).toContain('search_supplier');
    expect(names).toContain('list_objects');
  });

  it('update: [] → no update tool', () => {
    const restricted = {
      ...LEAD,
      permissions: { role: { read: 'all' as const, update: [] } },
    };
    const { names } = engineFor([SUPPLIER, TAG, restricted], { id: 'u4', roles: ['role'] });
    expect(names).toContain('search_lead');
    expect(names).not.toContain('update_lead');
  });

  it('open mode (no permissions map) → full CRUD', () => {
    const open = { ...LEAD, permissions: undefined };
    const { names } = engineFor([SUPPLIER, TAG, open], { id: 'u5', roles: ['any'] });
    expect(names).toContain('search_lead');
    expect(names).toContain('create_lead');
    expect(names).toContain('update_lead');
    expect(names).toContain('delete_lead');
  });
});

describe('fieldValueSchema — JSON Schema type mapping', () => {
  const defs = new Map([[SUPPLIER.name, SUPPLIER], [TAG.name, TAG]]);

  it('scalar types', () => {
    expect(fieldValueSchema({ name: 'a', type: 'string' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'a', type: 'text' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'a', type: 'datetime' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'a', type: 'date' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'a', type: 'seq_no' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'a', type: 'integer' }, defs)).toEqual({ type: 'integer' });
    expect(fieldValueSchema({ name: 'a', type: 'number' }, defs)).toEqual({ type: 'number' });
    expect(fieldValueSchema({ name: 'a', type: 'currency' }, defs)).toEqual({ type: 'number' });
    expect(fieldValueSchema({ name: 'a', type: 'boolean' }, defs)).toEqual({ type: 'boolean' });
    expect(fieldValueSchema({ name: 'a', type: 'json' }, defs)).toEqual({ type: 'object' });
  });

  it('enum single vs multiple', () => {
    expect(fieldValueSchema({ name: 's', type: 'enum', options: ['a', 'b'] }, defs)).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    });
    expect(fieldValueSchema({ name: 's', type: 'enum', options: ['a', 'b'], multiple: true }, defs)).toEqual({
      type: 'array',
      items: { type: 'string', enum: ['a', 'b'] },
    });
  });

  it('relation → target primary key type (string), multiRelation → array', () => {
    expect(fieldValueSchema({ name: 'r', type: 'relation', target: 'supplier' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'r', type: 'multiRelation', target: 'tag' }, defs)).toEqual({
      type: 'array',
      items: { type: 'integer' },
    });
  });

  it('string subtypes/image → string; person → target pk', () => {
    expect(fieldValueSchema({ name: 'fn', type: 'firstName' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'em', type: 'email' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'img', type: 'image' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'p', type: 'person', target: 'supplier' }, defs)).toEqual({ type: 'string' });
    expect(fieldValueSchema({ name: 'd', type: 'department', target: 'supplier' }, defs)).toEqual({ type: 'string' });
  });
});

function stripEngine(): McpEngine {
  const registry = new ObjectRegistry();
  registry.register(SUPPLIER);
  registry.register(TAG);
  registry.register(LEAD);
  registry.buildGraph();
  return { registry, pool: {} as never, dataAccess: {} as never, locale: 'en' };
}

describe('generate — schema stripping (fields.exclude)', () => {
  it('search schema strips excluded field from sort/fields enum', () => {
    const engine = stripEngine();
    const tools = compileToolsFor(engine, { id: 'u1', roles: ['sales'] });
    const search = tools.find((t) => t.spec.name === 'search_lead')!;
    const fields = search.spec.inputSchema.properties!.fields as { items: { enum: string[] } };
    expect(fields.items.enum).not.toContain('secret');
    expect(fields.items.enum).toContain('title');
  });

  it('create schema strips excluded field', () => {
    const engine = stripEngine();
    const tools = compileToolsFor(engine, { id: 'u1', roles: ['sales'] });
    const create = tools.find((t) => t.spec.name === 'create_lead')!;
    const data = create.spec.inputSchema.properties!.data as { properties: Record<string, unknown> };
    expect(data.properties.secret).toBeUndefined();
    expect(data.properties.title).toBeDefined();
  });

  it('update schema only exposes whitelist fields', () => {
    const engine = stripEngine();
    const tools = compileToolsFor(engine, { id: 'u1', roles: ['sales'] });
    const update = tools.find((t) => t.spec.name === 'update_lead')!;
    const changes = update.spec.inputSchema.properties!.changes as { properties: Record<string, unknown> };
    expect(Object.keys(changes.properties).sort()).toEqual(['status', 'title']);
  });
});

describe('generate — non-id primary key name', () => {
  const DOC_NO: ObjectDefinition = {
    name: 'repair_order',
    fields: [
      { name: 'doc_no', type: 'string', primary: true },
      { name: 'customer_name', type: 'string' },
    ],
  };

  function docNoEngine(): McpEngine {
    const registry = new ObjectRegistry();
    registry.register(DOC_NO);
    registry.buildGraph();
    return { registry, pool: {} as never, dataAccess: {} as never, locale: 'en' };
  }

  it('tool parameter name uses the real primary key name (doc_no), not a fixed id', () => {
    const engine = docNoEngine();
    const tools = compileToolsFor(engine, { id: 'u1', roles: ['any'] });
    const get = tools.find((t) => t.spec.name === 'get_repair_order')!;
    expect(Object.keys(get.spec.inputSchema.properties!)).toEqual(['doc_no']);
    expect(get.spec.inputSchema.required).toEqual(['doc_no']);
    const update = tools.find((t) => t.spec.name === 'update_repair_order')!;
    expect(Object.keys(update.spec.inputSchema.properties!)).toContain('doc_no');
    const del = tools.find((t) => t.spec.name === 'delete_repair_order')!;
    expect(del.spec.inputSchema.required).toEqual(['doc_no']);
  });

  it('tool description carries the real primary key name', () => {
    const engine = docNoEngine();
    const tools = compileToolsFor(engine, { id: 'u1', roles: ['any'] });
    const get = tools.find((t) => t.spec.name === 'get_repair_order')!;
    expect(get.spec.description).toContain('doc_no');
  });
});
