import Fastify from 'fastify';
import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, SchemaError } from '../../src/core/index.js';
import type { DataAccessContext, ObjectDataAccess } from '../../src/runtime/data-access/index.js';
import { buildAuthenticator } from '../../src/adapters/auth/index.js';
import { registerGraphQL, printGraphQLSchema, type GraphQLEngine } from '../../src/adapters/graphql/index.js';

interface Call {
  op: string;
  object: string;
  args: unknown[];
}

function leadRegistry(): ObjectRegistry {
  const registry = new ObjectRegistry();
  registry.register({
    name: 'lead',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'title', type: 'string', required: true },
      { name: 'amount', type: 'currency' },
    ],
  });
  return registry;
}

function workflowRegistry(): ObjectRegistry {
  const registry = new ObjectRegistry();
  registry.register({
    name: 'doc',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'state', type: 'enum', options: ['draft', 'running'] },
    ],
    workflowEnabled: true,
    workflow: { nodes: [{ id: 'open', assign: { roles: ['sales'] } }] },
  });
  return registry;
}

interface Harness {
  app: ReturnType<typeof Fastify>;
  calls: Call[];
  failNext(error: Error): void;
}

function makeApp(registry: ObjectRegistry): Harness {
  const app = Fastify();
  const calls: Call[] = [];
  let failure: Error | undefined;
  const maybeThrow = (): void => {
    if (failure !== undefined) {
      const error = failure;
      failure = undefined;
      throw error;
    }
  };
  const dataAccess = {
    async create(object: string, data: Record<string, unknown>) {
      maybeThrow();
      calls.push({ op: 'create', object, args: [data] });
      return { weave_id: '6:A1', ...data };
    },
    async update(object: string, id: string, changes: Record<string, unknown>) {
      maybeThrow();
      calls.push({ op: 'update', object, args: [id, changes] });
      return { weave_id: id, ...changes };
    },
    async delete(object: string, id: string) {
      maybeThrow();
      calls.push({ op: 'delete', object, args: [id] });
    },
    async transition(object: string, id: string, action: string, _ctx: DataAccessContext, payload?: unknown) {
      maybeThrow();
      calls.push({ op: 'transition', object, args: [id, action, payload] });
      return { weave_id: id };
    },
  } as unknown as ObjectDataAccess;
  const engine = { registry, pool: {}, dataAccess, locale: 'en' } as unknown as GraphQLEngine;
  const authenticator = buildAuthenticator({ source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } });
  registerGraphQL(app, { engine, authenticator, graphql: { enabled: true }, locale: 'en' });
  return {
    app,
    calls,
    failNext(error) {
      failure = error;
    },
  };
}

const AUTH = { authorization: 'Bearer sk-admin' };

async function gql(harness: Harness, query: string): Promise<Record<string, unknown>> {
  const res = await harness.app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: { query } });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe('GraphQL mutations (Phase 2)', () => {
  it('compiles the Mutation surface + create/update input types', () => {
    const schema = registerGraphQL(Fastify(), {
      engine: { registry: leadRegistry(), pool: {}, dataAccess: {}, locale: 'en' } as unknown as GraphQLEngine,
      authenticator: buildAuthenticator({ source: {} }),
      graphql: { enabled: true },
      locale: 'en',
    }).schema;
    const sdl = printGraphQLSchema(schema);

    expect(sdl).toContain('type Mutation {');
    expect(sdl).toContain('createLead(data: LeadCreateInput!): Lead!');
    expect(sdl).toContain('updateLead(id: ID!, changes: LeadUpdateInput!): Lead!');
    expect(sdl).toContain('deleteLead(id: ID!): Boolean!');
    // required create field is non-null
    expect(sdl).toContain('title: String!');
    // primary key is not writable on update
    const updateBlock = sdl.slice(sdl.indexOf('input LeadUpdateInput {'));
    expect(updateBlock.slice(0, updateBlock.indexOf('}'))).not.toContain('id:');
    // no workflow object → no transition mutation
    expect(sdl).not.toContain('transitionLead');
  });

  it('exposes transition only for objects that declare a workflow', () => {
    const schema = registerGraphQL(Fastify(), {
      engine: { registry: workflowRegistry(), pool: {}, dataAccess: {}, locale: 'en' } as unknown as GraphQLEngine,
      authenticator: buildAuthenticator({ source: {} }),
      graphql: { enabled: true },
      locale: 'en',
    }).schema;
    expect(printGraphQLSchema(schema)).toContain('transitionDoc(id: ID!, action: String!, payload: JSON): Doc!');
  });

  it('create → data-access.create', async () => {
    const harness = makeApp(leadRegistry());
    try {
      const body = await gql(harness, 'mutation { createLead(data: { title: "Acme" }) { weave_id title } }');
      expect((body.data as { createLead: { weave_id: string } }).createLead.weave_id).toBe('6:A1');
      expect(harness.calls[0]).toEqual({ op: 'create', object: 'lead', args: [{ title: 'Acme' }] });
    } finally {
      await harness.app.close();
    }
  });

  it('update → data-access.update by weave_id', async () => {
    const harness = makeApp(leadRegistry());
    try {
      await gql(harness, 'mutation { updateLead(id: "6:A1", changes: { title: "New" }) { weave_id } }');
      expect(harness.calls[0]).toEqual({ op: 'update', object: 'lead', args: ['6:A1', { title: 'New' }] });
    } finally {
      await harness.app.close();
    }
  });

  it('delete → data-access.delete, returns true', async () => {
    const harness = makeApp(leadRegistry());
    try {
      const body = await gql(harness, 'mutation { deleteLead(id: "6:A1") }');
      expect((body.data as { deleteLead: boolean }).deleteLead).toBe(true);
      expect(harness.calls[0]).toEqual({ op: 'delete', object: 'lead', args: ['6:A1'] });
    } finally {
      await harness.app.close();
    }
  });

  it('transition → data-access.transition', async () => {
    const harness = makeApp(workflowRegistry());
    try {
      await gql(harness, 'mutation { transitionDoc(id: "6:D1", action: "submit", payload: { comment: "ok" }) { weave_id } }');
      expect(harness.calls[0]).toEqual({ op: 'transition', object: 'doc', args: ['6:D1', 'submit', { comment: 'ok' }] });
    } finally {
      await harness.app.close();
    }
  });

  it('maps an RBAC write denial to extensions.code', async () => {
    const harness = makeApp(leadRegistry());
    try {
      harness.failNext(new SchemaError('rbac.denied.create', { object: 'lead', role: 'viewer' }, 'en'));
      const body = await gql(harness, 'mutation { createLead(data: { title: "x" }) { weave_id } }');
      const errors = (body.errors as { extensions: { code: string } }[]);
      expect(errors[0]!.extensions.code).toBe('rbac.denied.create');
    } finally {
      await harness.app.close();
    }
  });
});
