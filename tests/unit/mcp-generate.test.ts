import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry } from '../../src/core/object/registry.js';
import { compileToolsFor } from '../../src/adapters/mcp/generate.js';
import { INTROSPECTION_TOOLS, REGISTRY_TOOLS, WORKFLOW_TOOLS } from '../../src/core/index.js';
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
    { name: 'status', type: 'enum', options: ['open', 'won', 'archived'] },
    { name: 'secret', type: 'string' },
    { name: 'owner_id', type: 'string', ownership: true },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['title', 'status'], delete: true, fields: { exclude: ['secret'] } },
    finance: { read: 'all', fields: { exclude: ['secret'] } },
  },
};

const ALL_OPS = [
  REGISTRY_TOOLS.SEARCH,
  REGISTRY_TOOLS.GET,
  REGISTRY_TOOLS.CREATE,
  REGISTRY_TOOLS.UPDATE,
  REGISTRY_TOOLS.DELETE,
];

const TICKET: ObjectDefinition = {
  name: 'ticket',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'status', type: 'enum', options: ['draft', 'open'] },
  ],
  workflow: {
    initial: 'draft',
    stateField: 'status',
    states: [{ name: 'draft' }, { name: 'open' }],
    transitions: [{ action: 'open', from: 'draft', to: 'open' }],
  },
  permissions: {
    agent: { read: 'all', update: true },
    viewer: { read: 'all' },
  },
};

function engineFor(defs: ObjectDefinition[], subject: RbacSubject): { engine: McpEngine; names: string[] } {
  const registry = new ObjectRegistry();
  for (const def of defs) registry.register(def);
  registry.buildGraph();
  const engine: McpEngine = { registry, pool: {} as never, dataAccess: {} as never, locale: 'en' };
  return { engine, names: compileToolsFor(engine, subject).map((t) => t.spec.name) };
}

describe('compileToolsFor — registry tool surface', () => {
  it('sales (full CRUD on lead): all five ops + introspection', () => {
    const { names } = engineFor([LEAD], { id: 'u1', roles: ['sales'] });
    expect([...names].sort()).toEqual(
      [...ALL_OPS, INTROSPECTION_TOOLS.LIST_OBJECTS, INTROSPECTION_TOOLS.DESCRIBE_OBJECT].sort(),
    );
  });

  it('finance (read only): search + get only', () => {
    const { names } = engineFor([LEAD], { id: 'u2', roles: ['finance'] });
    expect(names).toContain(REGISTRY_TOOLS.SEARCH);
    expect(names).toContain(REGISTRY_TOOLS.GET);
    expect(names).not.toContain(REGISTRY_TOOLS.CREATE);
    expect(names).not.toContain(REGISTRY_TOOLS.UPDATE);
    expect(names).not.toContain(REGISTRY_TOOLS.DELETE);
    expect(names).toContain(INTROSPECTION_TOOLS.LIST_OBJECTS);
    expect(names).toContain(INTROSPECTION_TOOLS.DESCRIBE_OBJECT);
  });

  it('a role that can touch no object → introspection only (zero CRUD ops)', () => {
    const { names } = engineFor([LEAD], { id: 'u3', roles: ['ghost'] });
    expect(names).toEqual([INTROSPECTION_TOOLS.LIST_OBJECTS, INTROSPECTION_TOOLS.DESCRIBE_OBJECT]);
  });

  it('open-mode object (no permissions map) → full CRUD for any role', () => {
    const { names } = engineFor([SUPPLIER], { id: 'u4', roles: ['any'] });
    expect(names).toContain(REGISTRY_TOOLS.SEARCH);
    expect(names).toContain(REGISTRY_TOOLS.CREATE);
    expect(names).toContain(REGISTRY_TOOLS.DELETE);
  });

  it('update: [] → no update op', () => {
    const restricted: ObjectDefinition = {
      ...LEAD,
      permissions: { role: { read: 'all' as const, update: [] } },
    };
    const { names } = engineFor([restricted], { id: 'u5', roles: ['role'] });
    expect(names).toContain(REGISTRY_TOOLS.SEARCH);
    expect(names).not.toContain(REGISTRY_TOOLS.UPDATE);
  });

  it('surface size is fixed — independent of the number of objects', () => {
    const one = engineFor([SUPPLIER], { id: 'u6', roles: ['any'] }).names;
    const many = engineFor([SUPPLIER, TAG, LEAD], { id: 'u6', roles: ['any'] }).names;
    expect([...many].sort()).toEqual([...one].sort());
  });

  it('input schemas take the object name; the surface never enumerates object fields', () => {
    const { engine } = engineFor([LEAD], { id: 'u7', roles: ['sales'] });
    const tools = compileToolsFor(engine, { id: 'u7', roles: ['sales'] });

    const search = tools.find((t) => t.spec.name === REGISTRY_TOOLS.SEARCH)!;
    expect(search.spec.inputSchema.required).toEqual(['object']);
    expect(search.spec.inputSchema.properties!.object).toMatchObject({ type: 'string' });
    // no per-object field enumeration (the enum options / hidden field must not leak)
    const searchJson = JSON.stringify(search.spec.inputSchema);
    expect(searchJson).not.toContain('archived');
    expect(searchJson).not.toContain('secret');

    const update = tools.find((t) => t.spec.name === REGISTRY_TOOLS.UPDATE)!;
    expect(update.spec.inputSchema.required).toEqual(['object', 'id', 'changes']);
  });

  it('workflow_transition appears only for roles that can update a workflow object', () => {
    const agent = engineFor([TICKET], { id: 'u8', roles: ['agent'] }).names;
    expect(agent).toContain(WORKFLOW_TOOLS.TRANSITION);

    const viewer = engineFor([TICKET], { id: 'u9', roles: ['viewer'] }).names;
    expect(viewer).not.toContain(WORKFLOW_TOOLS.TRANSITION);

    // an object without a workflow never exposes the transition tool
    const noWorkflow = engineFor([LEAD], { id: 'u10', roles: ['sales'] }).names;
    expect(noWorkflow).not.toContain(WORKFLOW_TOOLS.TRANSITION);
  });

  it('workflow_transition input schema takes object/id/action, never the transitions', () => {
    const { engine } = engineFor([TICKET], { id: 'u11', roles: ['agent'] });
    const tool = compileToolsFor(engine, { id: 'u11', roles: ['agent'] }).find(
      (t) => t.spec.name === WORKFLOW_TOOLS.TRANSITION,
    )!;
    expect(tool.spec.inputSchema.required).toEqual(['object', 'id', 'action']);
    expect(JSON.stringify(tool.spec.inputSchema)).not.toContain('open');
  });
});
