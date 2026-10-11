import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry } from '../../src/core/object/registry.js';
import { MCP_RESOURCES, listResources, readResource } from '../../src/adapters/mcp/resources.js';
import type { McpEngine } from '../../src/adapters/mcp/types.js';
import type { McpSession } from '../../src/adapters/mcp/session.js';
import type { IdentitySubject, ObjectDefinition } from '../../src/core/index.js';

const LEAD: ObjectDefinition = {
  name: 'lead',
  labels: { en: 'Lead' },
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'all', fields: { exclude: ['secret'] } },
  },
};

const SECRET: ObjectDefinition = {
  name: 'secret_obj',
  fields: [{ name: 'id', type: 'string', primary: true }],
  permissions: { nobody: { read: 'all' } },
};

function setup(defs: ObjectDefinition[], roles: string[]): { engine: McpEngine; session: McpSession } {
  const registry = new ObjectRegistry();
  for (const def of defs) registry.register(def);
  registry.buildGraph();
  const user: IdentitySubject = { id: 'u1', roles };
  const engine: McpEngine = { registry, pool: {} as never, dataAccess: {} as never, locale: 'en' };
  const session: McpSession = {
    id: 's1',
    agentCredentialId: 'key-1',
    agentSubject: { id: 'agent', roles: ['agent'] },
    user,
    onBehalfOf: 'alice',
    createdAt: new Date(),
    lastActivity: new Date(),
  };
  return { engine, session };
}

describe('MCP resources — schema-derived, RBAC-filtered', () => {
  it('lists the objects resource plus each readable object', () => {
    const { engine, session } = setup([LEAD, SECRET], ['sales']);
    const uris = listResources(engine, session).map((r) => r.uri);
    expect(uris).toContain(MCP_RESOURCES.OBJECTS);
    expect(uris).toContain(`${MCP_RESOURCES.OBJECT_PREFIX}lead`);
    expect(uris).not.toContain(`${MCP_RESOURCES.OBJECT_PREFIX}secret_obj`);
  });

  it('reads the objects resource', () => {
    const { engine, session } = setup([LEAD, SECRET], ['sales']);
    const content = readResource(engine, session, MCP_RESOURCES.OBJECTS, 'en');
    const body = JSON.parse(content.text) as { objects: Array<{ name: string }> };
    expect(body.objects.map((o) => o.name)).toEqual(['lead']);
  });

  it('reads an object descriptor with excluded fields stripped', () => {
    const { engine, session } = setup([LEAD], ['sales']);
    const content = readResource(engine, session, `${MCP_RESOURCES.OBJECT_PREFIX}lead`, 'en');
    const body = JSON.parse(content.text) as { name: string; fields: Array<{ name: string }> };
    expect(body.name).toBe('lead');
    expect(body.fields.map((f) => f.name)).not.toContain('secret');
  });

  it('an unreadable object → rbac.denied.read', () => {
    const { engine, session } = setup([SECRET], ['sales']);
    expect(() => readResource(engine, session, `${MCP_RESOURCES.OBJECT_PREFIX}secret_obj`, 'en')).toThrow();
  });

  it('an unknown URI → not found', () => {
    const { engine, session } = setup([LEAD], ['sales']);
    expect(() => readResource(engine, session, 'weavekit://nope', 'en')).toThrow();
  });
});
