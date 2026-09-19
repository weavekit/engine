import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { registerAuditRoutes } from '../../src/adapters/rest/audit.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';
import type { AuditQuery, AuditQueryEngine } from '../../src/core/audit/index.js';
import type { Locale } from '../../src/core/i18n/index.js';

const locale: Locale = 'en';

function fakeAuthenticator(key: string): Authenticator {
  return {
    resolve: async (header?: string) => {
      if (header === `Bearer ${key}`) return { id: 'u-admin', roles: ['admin'] };
      return null;
    },
  };
}

function mockAudit(): { engine: AuditQueryEngine; calls: AuditQuery[] } {
  const calls: AuditQuery[] = [];
  const engine = {
    record: async () => {},
    recordBatch: async () => {},
    query: async (q: AuditQuery = {}) => {
      calls.push(q);
      return { rows: [], total: 0 };
    },
  } as AuditQueryEngine;
  return { engine, calls };
}

async function buildApp(audit: AuditQueryEngine) {
  const app = Fastify();
  setErrorHandlers(app, locale);
  registerAuditRoutes(
    app,
    {
      registry: {} as never,
      pool: {} as never,
      dataAccess: {} as never,
      authenticator: fakeAuthenticator('sk-admin'),
      locale,
      audit,
    },
    { prefix: '/api', adminRoles: ['admin'] },
  );
  await app.ready();
  return app;
}

describe('registerAuditRoutes — /api/audit generic filter', () => {
  it('parses the `filter` JSON param and forwards it to the audit engine', async () => {
    const { engine, calls } = mockAudit();
    const app = await buildApp(engine);

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit?filter=%7B%22action%22%3A%7B%22like%22%3A%22create%22%7D%7D&limit=20&offset=0',
      headers: { authorization: 'Bearer sk-admin' },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      filter: { action: { like: 'create' } },
      limit: 20,
      offset: 0,
    });
  });

  it('forwards a ts range (date filter) as { gte, lte }', async () => {
    const { engine, calls } = mockAudit();
    const app = await buildApp(engine);

    const filter = encodeURIComponent(JSON.stringify({ ts: { gte: '2026-08-01', lte: '2026-08-31' } }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/audit?filter=${filter}&limit=10&offset=0`,
      headers: { authorization: 'Bearer sk-admin' },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      filter: { ts: { gte: '2026-08-01', lte: '2026-08-31' } },
      limit: 10,
      offset: 0,
    });
  });

  it('rejects a malformed `filter` JSON', async () => {
    const { engine, calls } = mockAudit();
    const app = await buildApp(engine);

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit?filter=not-json',
      headers: { authorization: 'Bearer sk-admin' },
    });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
