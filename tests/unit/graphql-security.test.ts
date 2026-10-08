import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'graphql';
import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry } from '../../src/core/index.js';
import type { ObjectDataAccess } from '../../src/runtime/data-access/index.js';
import { buildAuthenticator } from '../../src/adapters/auth/index.js';
import { operationHash, registerGraphQL, type EngineGraphQLConfig, type GraphQLEngine } from '../../src/adapters/graphql/index.js';

const AUTH = { authorization: 'Bearer sk-admin' };

function makeApp(options: EngineGraphQLConfig): ReturnType<typeof Fastify> {
  const app = Fastify();
  const registry = new ObjectRegistry();
  registry.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'title', type: 'string' }] });
  const dataAccess = {
    async find() {
      return { rows: [], total: 0 };
    },
  } as unknown as ObjectDataAccess;
  const engine = { registry, pool: {}, dataAccess, locale: 'en' } as unknown as GraphQLEngine;
  const authenticator = buildAuthenticator({ source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } });
  registerGraphQL(app, { engine, authenticator, graphql: { enabled: true, ...options }, locale: 'en' });
  return app;
}

async function post(app: ReturnType<typeof Fastify>, query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: { query } });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe('GraphQL hardening (Phase 4)', () => {
  it('allows introspection by default and rejects it when disabled', async () => {
    const open = makeApp({});
    try {
      const res = await post(open, '{ __schema { queryType { name } } }');
      expect(res.status).toBe(200);
      expect((res.body.data as { __schema: { queryType: { name: string } } }).__schema.queryType.name).toBe('Query');
    } finally {
      await open.close();
    }

    const closed = makeApp({ security: { introspection: false } });
    try {
      const res = await post(closed, '{ __schema { queryType { name } } }');
      expect(res.status).toBe(200);
      expect((res.body.errors as unknown[]).length).toBeGreaterThan(0);
      expect(res.body.data).toBeUndefined();
    } finally {
      await closed.close();
    }
  });

  it('enforces the allow list (approved hash runs, others denied)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wk-gql-allow-'));
    const file = join(dir, 'allowlist.json');
    const approved = '{ _objectCount }';
    await writeFile(file, JSON.stringify({ operations: [operationHash(parse(approved))] }));
    const app = makeApp({ security: { allowList: { enabled: true, file } } });
    try {
      const ok = await post(app, approved);
      expect(ok.status).toBe(200);
      expect((ok.body.data as { _objectCount: number })._objectCount).toBe(1);

      const denied = await post(app, '{ lead { total } }');
      expect(denied.status).toBe(200);
      const errors = denied.body.errors as { extensions: { code: string } }[];
      expect(errors[0]!.extensions.code).toBe('graphql.allowList.denied');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
