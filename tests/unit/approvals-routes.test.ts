import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { registerApprovalsRoutes } from '../../src/adapters/rest/approvals.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';
import type { ToolApprovals } from '../../src/core/tools/types.js';
import type { Locale } from '../../src/core/i18n/index.js';

const locale: Locale = 'en';

function fakeAuthenticator(key: string): Authenticator {
  return {
    resolve: async (header?: string) => {
      if (header === `Bearer ${key}`) return { id: 'u-admin', roles: ['admin'] };
      if (header === 'Bearer sk-viewer') return { id: 'u-viewer', roles: ['viewer'] };
      return null;
    },
  };
}

function mockApprovals(): ToolApprovals {
  const rows = [
    {
      approvalKey: 'ap-1',
      action: 'mcp.tool.x',
      args: { a: 1 },
      status: 'pending' as const,
      createdAt: new Date('2026-08-31T10:00:00Z'),
      actorKey: 'agent-1',
    },
  ];
  return {
    list: async (filter) => (filter?.status === 'approved' ? [] : rows),
    count: async () => rows.length,
    query: async () => rows,
    approve: async (key) => key === 'ap-1',
    reject: async (key) => key === 'ap-1',
  };
}

async function buildApp(approvals: ToolApprovals) {
  const app = Fastify();
  setErrorHandlers(app, locale);
  registerApprovalsRoutes(
    app,
    {
      registry: {} as never,
      pool: {} as never,
      dataAccess: {} as never,
      authenticator: fakeAuthenticator('sk-admin'),
      locale,
      approvals,
    },
    { prefix: '/api', adminRoles: ['admin'] },
  );
  await app.ready();
  return app;
}

describe('registerApprovalsRoutes — /api/approvals', () => {
  it('requires auth (401 without a key)', async () => {
    const app = await buildApp(mockApprovals());
    const res = await app.inject({ method: 'GET', url: '/api/approvals' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('gates reads to adminRoles (403 for a non-admin)', async () => {
    const app = await buildApp(mockApprovals());
    const res = await app.inject({
      method: 'GET',
      url: '/api/approvals',
      headers: { authorization: 'Bearer sk-viewer' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns paged rows + total for an admin', async () => {
    const app = await buildApp(mockApprovals());
    const res = await app.inject({
      method: 'GET',
      url: '/api/approvals?status=pending&limit=20',
      headers: { authorization: 'Bearer sk-admin' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.rows).toHaveLength(1);
    await app.close();
  });

  it('approves a pending entry as the authenticated admin', async () => {
    const app = await buildApp(mockApprovals());
    const res = await app.inject({
      method: 'POST',
      url: '/api/approvals/ap-1/approve',
      headers: { authorization: 'Bearer sk-admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ approvalKey: 'ap-1', status: 'approved', approver: 'u-admin' });
    await app.close();
  });

  it('404s when the entry is not pending', async () => {
    const app = await buildApp(mockApprovals());
    const res = await app.inject({
      method: 'POST',
      url: '/api/approvals/missing/reject',
      headers: { authorization: 'Bearer sk-admin' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
