import { describe, it, expect } from '../helpers/test.js';import Fastify from 'fastify';
import type { Pool } from 'pg';
import { registerOpsRoutes } from '../../src/adapters/ops/index.js';

function okPool(): Pool {
  return {
    query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }),
  } as unknown as Pool;
}

function downPool(): Pool {
  return {
    query: async () => {
      throw new Error('connection refused');
    },
  } as unknown as Pool;
}

describe('registerOpsRoutes', () => {
  it('GET /health → 200 ok (does not touch DB)', async () => {
    const app = Fastify();
    registerOpsRoutes(app, { pool: downPool(), version: '1.2.3' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json() as { status: string }).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /ready → PG reachable 200 ok/up', async () => {
    const app = Fastify();
    registerOpsRoutes(app, { pool: okPool(), version: '1.2.3' });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json() as { status: string; db: string }).toEqual({ status: 'ok', db: 'up' });
    await app.close();
  });

  it('GET /ready → PG unreachable 503 error/down', async () => {
    const app = Fastify();
    registerOpsRoutes(app, { pool: downPool(), version: '1.2.3' });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json() as { status: string; db: string }).toEqual({ status: 'error', db: 'down' });
    await app.close();
  });

  it('GET /version → returns engine version', async () => {
    const app = Fastify();
    registerOpsRoutes(app, { pool: okPool(), version: '1.2.3' });
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json() as { name: string; version: string }).toEqual({ name: 'weavekit', version: '1.2.3' });
    await app.close();
  });
});
