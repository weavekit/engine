import Fastify from 'fastify';
import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry } from '../../src/core/index.js';
import { buildAuthenticator } from '../../src/adapters/auth/index.js';
import { registerGraphQL, type EngineGraphQLConfig, type GraphQLEngine } from '../../src/adapters/graphql/index.js';

function makeApp(options: EngineGraphQLConfig = {}): ReturnType<typeof Fastify> {
  const app = Fastify();
  const registry = new ObjectRegistry();
  registry.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }] });
  const engine = { registry, pool: {}, dataAccess: {}, locale: 'en' } as unknown as GraphQLEngine;
  const authenticator = buildAuthenticator({ source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } });
  registerGraphQL(app, { engine, authenticator, graphql: { enabled: true, ...options }, locale: 'en' });
  return app;
}

const AUTH = { authorization: 'Bearer sk-admin' };

describe('GraphQL adapter — Phase 0 skeleton (/graphql)', () => {
  it('rejects a missing bearer key with a plain 401', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/graphql', payload: { query: '{ _objectCount }' } });
      expect(res.statusCode).toBe(401);
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('auth.missingKey');
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid bearer key with 401', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { authorization: 'Bearer nope' },
        payload: { query: '{ _objectCount }' },
      });
      expect(res.statusCode).toBe(401);
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('auth.invalidKey');
    } finally {
      await app.close();
    }
  });

  it('executes a query over POST for a valid key', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: { query: '{ _objectCount }' } });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { data: { _objectCount: number } }).data._objectCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('executes a query over GET', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/graphql?query=${encodeURIComponent('{ _objectCount }')}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { data: { _objectCount: number } }).data._objectCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('returns 200 + errors for a validation error (over-HTTP spec)', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: { query: '{ nope }' } });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('returns 400 when the query is missing', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/graphql', headers: AUTH, payload: {} });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('http.param.invalid');
    } finally {
      await app.close();
    }
  });

  it('honours a custom prefix and a rate limit', async () => {
    const app = makeApp({ prefix: '/gql', rateLimit: { max: 1, windowMs: 60_000 } });
    try {
      const first = await app.inject({ method: 'POST', url: '/gql', headers: AUTH, payload: { query: '{ _objectCount }' } });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: 'POST', url: '/gql', headers: AUTH, payload: { query: '{ _objectCount }' } });
      expect(second.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
