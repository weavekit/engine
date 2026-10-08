import Fastify from 'fastify';
import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, SchemaError } from '../../src/core/index.js';
import type { DataAccessContext, FindOptions, ObjectDataAccess } from '../../src/runtime/data-access/index.js';
import { buildAuthenticator } from '../../src/adapters/auth/index.js';
import { registerGraphQL, printGraphQLSchema, type EngineGraphQLConfig, type GraphQLEngine } from '../../src/adapters/graphql/index.js';

interface FindCall {
  object: string;
  opts: FindOptions;
  ctx: DataAccessContext;
}
interface FindOneCall {
  object: string;
  id: string;
  ctx: DataAccessContext;
}

interface Harness {
  app: ReturnType<typeof Fastify>;
  finds: FindCall[];
  findOnes: FindOneCall[];
  failFind(error: Error): void;
  findResult(result: { rows: Record<string, unknown>[]; total: number }): void;
}

function buildRegistry(): ObjectRegistry {
  const registry = new ObjectRegistry();
  registry.register({
    name: 'lead',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'title', type: 'string' },
      { name: 'amount', type: 'currency' },
      { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
      { name: 'meta', type: 'jsonb' },
      { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true },
    ],
  });
  return registry;
}

function makeApp(registry: ObjectRegistry, options: EngineGraphQLConfig = {}): Harness {
  const app = Fastify();
  const finds: FindCall[] = [];
  const findOnes: FindOneCall[] = [];
  let findImpl: (call: FindCall) => { rows: Record<string, unknown>[]; total: number } = () => ({
    rows: [{ weave_id: '6:A1', title: 'Acme', status: 'open' }],
    total: 1,
  });
  const dataAccess = {
    async find(object: string, opts: FindOptions, ctx: DataAccessContext) {
      const call: FindCall = { object, opts, ctx };
      finds.push(call);
      return findImpl(call);
    },
    async findOne(object: string, id: string, ctx: DataAccessContext) {
      findOnes.push({ object, id, ctx });
      return { weave_id: id, title: 'Acme' };
    },
  } as unknown as ObjectDataAccess;
  const engine = { registry, pool: {}, dataAccess, locale: 'en' } as unknown as GraphQLEngine;
  const authenticator = buildAuthenticator({ source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } });
  registerGraphQL(app, { engine, authenticator, graphql: { enabled: true, ...options }, locale: 'en' });
  return {
    app,
    finds,
    findOnes,
    failFind(error) {
      findImpl = () => {
        throw error;
      };
    },
    findResult(result) {
      findImpl = () => result;
    },
  };
}

const AUTH = { authorization: 'Bearer sk-admin' };

describe('GraphQL schema (Phase 1)', () => {
  it('compiles object types, enums and Query from the registry', () => {
    const sdl = printGraphQLSchema(registerGraphQL(Fastify(), {
      engine: { registry: buildRegistry(), pool: {}, dataAccess: {}, locale: 'en' } as unknown as GraphQLEngine,
      authenticator: buildAuthenticator({ source: {} }),
      graphql: { enabled: true },
      locale: 'en',
    }).schema);

    expect(sdl).toContain('type Lead {');
    expect(sdl).toContain('weave_id: ID!');
    expect(sdl).toContain('amount: Float');
    expect(sdl).toContain('status: LeadStatus');
    expect(sdl).toContain('tags: [LeadTags]');
    expect(sdl).toContain('enum LeadStatus {');
    expect(sdl).toContain('type LeadPage {');
    expect(sdl).toContain('lead(');
    expect(sdl).toContain('lead_by_id(id: ID!): Lead');
    expect(sdl).toContain('input SortInput {');
    expect(sdl).toContain('enum SortDir {');
  });

  it('maps list args to data-access and returns rows + total', async () => {
    const harness = makeApp(buildRegistry());
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/graphql',
        headers: AUTH,
        payload: {
          query: '{ lead(filter: { status: "open" }, sort: [{ field: "title", dir: desc }], limit: 5, offset: 2) { total rows { weave_id title } } }',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: { lead: { total: number; rows: { weave_id: string }[] } } };
      expect(body.data.lead.total).toBe(1);
      expect(body.data.lead.rows[0]!.weave_id).toBe('6:A1');

      const call = harness.finds[0]!;
      expect(call.object).toBe('lead');
      expect(call.opts.limit).toBe(5);
      expect(call.opts.offset).toBe(2);
      expect(call.opts.sort).toEqual([{ field: 'title', dir: 'desc' }]);
      expect(call.opts.filter).toEqual({ status: 'open' });
      expect(call.opts.fields?.includes('weave_id')).toBe(true);
      expect(call.ctx.subject?.id).toBe('admin');
    } finally {
      await harness.app.close();
    }
  });

  it('resolves a single record by weave_id', async () => {
    const harness = makeApp(buildRegistry());
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/graphql',
        headers: AUTH,
        payload: { query: '{ lead_by_id(id: "6:A1") { weave_id title } }' },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.findOnes[0]!.id).toBe('6:A1');
      expect((JSON.parse(res.body) as { data: { lead_by_id: { title: string } } }).data.lead_by_id.title).toBe('Acme');
    } finally {
      await harness.app.close();
    }
  });

  it('maps a SchemaError from data-access to extensions.code', async () => {
    const harness = makeApp(buildRegistry());
    try {
      harness.failFind(new SchemaError('rbac.denied.read', { object: 'lead', role: 'viewer' }, 'en'));
      const res = await harness.app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: { query: '{ lead { total } }' } });
      expect(res.statusCode).toBe(200);
      const errors = (JSON.parse(res.body) as { errors: { extensions: { code: string } }[] }).errors;
      expect(errors[0]!.extensions.code).toBe('rbac.denied.read');
    } finally {
      await harness.app.close();
    }
  });

  it('rejects a query deeper than maxDepth', async () => {
    const harness = makeApp(buildRegistry(), { security: { maxDepth: 1 } });
    try {
      const res = await harness.app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: { query: '{ lead { total } }' } });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { errors: { extensions: { code: string } }[] }).errors[0]!.extensions.code).toBe(
        'graphql.depthExceeded',
      );
    } finally {
      await harness.app.close();
    }
  });

  it('rejects a query over maxComplexity', async () => {
    const harness = makeApp(buildRegistry(), { security: { maxComplexity: 1 } });
    try {
      const res = await harness.app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: { query: '{ lead { total rows { weave_id } } }' } });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { errors: { extensions: { code: string } }[] }).errors[0]!.extensions.code).toBe(
        'graphql.complexityExceeded',
      );
    } finally {
      await harness.app.close();
    }
  });

  it('rejects a query over maxAliases', async () => {
    const harness = makeApp(buildRegistry(), { security: { maxAliases: 1 } });
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/graphql',
        headers: AUTH,
        payload: { query: '{ a: _objectCount b: _objectCount }' },
      });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { errors: { extensions: { code: string } }[] }).errors[0]!.extensions.code).toBe(
        'graphql.aliasExceeded',
      );
    } finally {
      await harness.app.close();
    }
  });
});
