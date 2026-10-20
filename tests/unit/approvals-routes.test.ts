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
      status: 'pending' as 'pending' | 'approved' | 'rejected',
      createdAt: new Date('2026-08-31T10:00:00Z'),
      actorKey: 'agent-1',
    },
  ];
  return {
    list: async (filter) => (filter?.status === 'approved' ? [] : rows),
    count: async () => rows.length,
    query: async () => rows,
    approve: async (key) => {
      const row = rows.find((item) => item.approvalKey === key);
      if (row === undefined) return false;
      row.status = 'approved';
      return true;
    },
    reject: async (key) => {
      const row = rows.find((item) => item.approvalKey === key);
      if (row === undefined) return false;
      row.status = 'rejected';
      return true;
    },
    vote: async (key) => {
      const row = rows.find((item) => item.approvalKey === key);
      if (row === undefined) return false;
      row.status = 'approved';
      return true;
    },
    votes: async () => [],
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
      headers: { authorization: 'Bearer sk-admin', 'content-type': 'application/json' },
      payload: { comment: 'not pending' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
describe('approval decisions + votes', () => {
  it('records a decision via the quorum endpoint and returns the resulting state', async () => {
    const app = await buildApp(mockApprovals());
    const res = await app.inject({
      method: 'POST',
      url: '/api/approvals/ap-1/decisions',
      headers: { authorization: 'Bearer sk-admin', 'content-type': 'application/json' },
      payload: { decision: 'approved', comment: 'ok' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      approvalKey: 'ap-1',
      status: 'approved',
      approvedCount: 0,
      requiredApprovals: 1,
    });
    await app.close();
  });

  it('lists votes', async () => {
    const app = await buildApp(mockApprovals());
    const res = await app.inject({
      method: 'GET',
      url: '/api/approvals/ap-1/votes',
      headers: { authorization: 'Bearer sk-admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ approvalKey: 'ap-1', votes: [] });
    await app.close();
  });

  it('forwards the expiresBefore filter to the store', async () => {
    let seen: { expiresBefore?: Date } | undefined;
    const approvals: ToolApprovals = {
      ...mockApprovals(),
      list: async (filter) => {
        seen = filter;
        return [];
      },
      count: async () => 0,
    };
    const app = await buildApp(approvals);
    const expiresBefore = '2026-10-21T00:00:00.000Z';
    const res = await app.inject({
      method: 'GET',
      url: `/api/approvals?expiresBefore=${encodeURIComponent(expiresBefore)}`,
      headers: { authorization: 'Bearer sk-admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(seen?.expiresBefore?.toISOString()).toBe(expiresBefore);
    await app.close();
  });
});