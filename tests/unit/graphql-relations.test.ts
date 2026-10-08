import Fastify from 'fastify';
import { describe, it, expect } from '../helpers/test.js';
import { encodeRecordKey, ObjectRegistry } from '../../src/core/index.js';
import type { ObjectDataAccess } from '../../src/runtime/data-access/index.js';
import { buildAuthenticator } from '../../src/adapters/auth/index.js';
import { registerGraphQL, printGraphQLSchema, type GraphQLEngine } from '../../src/adapters/graphql/index.js';

const AUTH = { authorization: 'Bearer sk-admin' };

type Row = Record<string, unknown>;

interface Harness {
  app: ReturnType<typeof Fastify>;
  finds: string[];
}

function makeApp(registry: ObjectRegistry, data: Record<string, Row[]>): Harness {
  const app = Fastify();
  const finds: string[] = [];
  const dataAccess = {
    async find(object: string) {
      finds.push(object);
      const rows = data[object] ?? [];
      return { rows, total: rows.length };
    },
    async findOne(object: string, id: string) {
      finds.push(object);
      return (data[object] ?? []).find((r) => r['weave_id'] === id) ?? null;
    },
  } as unknown as ObjectDataAccess;
  const engine = { registry, pool: {}, dataAccess, locale: 'en' } as unknown as GraphQLEngine;
  const authenticator = buildAuthenticator({ source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } });
  registerGraphQL(app, { engine, authenticator, graphql: { enabled: true }, locale: 'en' });
  return { app, finds };
}

async function gql(harness: Harness, query: string): Promise<Record<string, unknown>> {
  const res = await harness.app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: { query } });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  expect(body.errors).toBeUndefined();
  return body;
}

function schemaOf(registry: ObjectRegistry): string {
  return printGraphQLSchema(
    registerGraphQL(Fastify(), {
      engine: { registry, pool: {}, dataAccess: {}, locale: 'en' } as unknown as GraphQLEngine,
      authenticator: buildAuthenticator({ source: {} }),
      graphql: { enabled: true },
      locale: 'en',
    }).schema,
  );
}

function orderRegistry(): ObjectRegistry {
  const registry = new ObjectRegistry();
  registry.register({ name: 'customers', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }] });
  registry.register({
    name: 'orders',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'customer_id', type: 'relation', target: 'customers' },
    ],
  });
  registry.buildGraph();
  return registry;
}

describe('GraphQL relations (Phase 3)', () => {
  it('compiles relation / details / multiRelation fields', () => {
    const registry = new ObjectRegistry();
    registry.register({ name: 'customers', fields: [{ name: 'id', type: 'string', primary: true }] });
    registry.register({ name: 'tags', fields: [{ name: 'id', type: 'string', primary: true }] });
    registry.register({ name: 'lines', fields: [{ name: 'id', type: 'string', primary: true }] });
    registry.register({
      name: 'orders',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'owner_id', type: 'string' },
        { name: 'customer_id', type: 'relation', target: 'customers' },
        { name: 'tags', type: 'multiRelation', target: 'tags' },
        { name: 'lines', type: 'details', target: 'lines' },
        { name: 'assignee', type: 'user' },
      ],
    });
    registry.buildGraph();
    const sdl = schemaOf(registry);
    expect(sdl).toContain('customer_id: Customers');
    expect(sdl).toContain('tags: [Tags!]!');
    expect(sdl).toContain('lines: [Lines!]!');
    expect(sdl).toContain('assignee: String'); // implicit identity FK → raw id
  });

  it('batches a relation across a list (one target query, not N)', async () => {
    const harness = makeApp(orderRegistry(), {
      orders: [
        { weave_id: encodeRecordKey(['O1']), id: 'O1', customer_id: 'C1' },
        { weave_id: encodeRecordKey(['O2']), id: 'O2', customer_id: 'C2' },
      ],
      customers: [
        { weave_id: encodeRecordKey(['C1']), id: 'C1', name: 'Acme' },
        { weave_id: encodeRecordKey(['C2']), id: 'C2', name: 'Globex' },
      ],
    });
    try {
      const body = await gql(harness, '{ orders { rows { weave_id customer_id { weave_id name } } } }');
      const rows = (body.data as { orders: { rows: { customer_id: { name: string } }[] } }).orders.rows;
      expect(rows[0]!.customer_id.name).toBe('Acme');
      expect(rows[1]!.customer_id.name).toBe('Globex');
      // one root query + one batched relation query (would be 3 without the loader)
      expect(harness.finds.filter((o) => o === 'orders').length).toBe(1);
      expect(harness.finds.filter((o) => o === 'customers').length).toBe(1);
    } finally {
      await harness.app.close();
    }
  });

  it('batches details children across a list (one child query)', async () => {
    const registry = new ObjectRegistry();
    registry.register({
      name: 'invoices',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'lines', type: 'details', target: 'invoice_lines' },
      ],
    });
    registry.register({
      name: 'invoice_lines',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'sku', type: 'string' },
      ],
    });
    registry.buildGraph();

    const i1 = encodeRecordKey(['I1']);
    const i2 = encodeRecordKey(['I2']);
    const harness = makeApp(registry, {
      invoices: [
        { weave_id: i1, id: 'I1' },
        { weave_id: i2, id: 'I2' },
      ],
      invoice_lines: [
        { weave_id: encodeRecordKey(['L1']), id: 'L1', parent_id: i1, parent_idx: 0, sku: 'a' },
        { weave_id: encodeRecordKey(['L2']), id: 'L2', parent_id: i2, parent_idx: 0, sku: 'b' },
      ],
    });
    try {
      const body = await gql(harness, '{ invoices { rows { weave_id lines { sku } } } }');
      const rows = (body.data as { invoices: { rows: { lines: { sku: string }[] }[] } }).invoices.rows;
      expect(rows[0]!.lines[0]!.sku).toBe('a');
      expect(rows[1]!.lines[0]!.sku).toBe('b');
      expect(harness.finds.filter((o) => o === 'invoices').length).toBe(1);
      expect(harness.finds.filter((o) => o === 'invoice_lines').length).toBe(1);
    } finally {
      await harness.app.close();
    }
  });

  it('batches multiRelation targets across a list', async () => {
    const registry = new ObjectRegistry();
    registry.register({ name: 'tags', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }] });
    registry.register({
      name: 'articles',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'tags', type: 'multiRelation', target: 'tags' },
      ],
    });
    registry.buildGraph();

    const harness = makeApp(registry, {
      articles: [
        { weave_id: encodeRecordKey(['A1']), id: 'A1', tags: ['T1', 'T2'] },
        { weave_id: encodeRecordKey(['A2']), id: 'A2', tags: ['T2'] },
      ],
      tags: [
        { weave_id: encodeRecordKey(['T1']), id: 'T1', name: 'one' },
        { weave_id: encodeRecordKey(['T2']), id: 'T2', name: 'two' },
      ],
    });
    try {
      const body = await gql(harness, '{ articles { rows { weave_id tags { name } } } }');
      const rows = (body.data as { articles: { rows: { tags: { name: string }[] }[] } }).articles.rows;
      expect(rows[0]!.tags.map((t) => t.name)).toEqual(['one', 'two']);
      expect(rows[1]!.tags.map((t) => t.name)).toEqual(['two']);
      expect(harness.finds.filter((o) => o === 'articles').length).toBe(1);
      expect(harness.finds.filter((o) => o === 'tags').length).toBe(1);
    } finally {
      await harness.app.close();
    }
  });
});
