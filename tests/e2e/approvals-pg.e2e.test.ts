import { describe, it, after, expect } from '../helpers/test.js';
import { createPool } from '../../src/index.js';
import { createApprovalsBackend } from '../../src/subsystems/approvals/index.js';
import type { Pool } from 'pg';
import type { PendingApproval } from '../../src/core/tools/types.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Approvals subsystem PG E2E (local database)', () => {
  let pool: Pool;

  it('Persistence: upsert/list/get/resolve/count full path', async () => {
    pool = createPool(url!);
    await pool.query('DROP TABLE IF EXISTS weavekit_approvals CASCADE');
    const backend = await createApprovalsBackend(pool);

    const pending: PendingApproval = {
      approvalKey: 'ap-pg-1',
      action: 'mcp.tool.x',
      args: { a: 1, b: [2, 3] },
      status: 'pending',
      createdAt: new Date('2026-08-31T10:00:00Z'),
      actorKey: 'agent-1',
    };

    // create via upsert (create-only: ON CONFLICT DO NOTHING) — a re-upsert of
    // an existing key never changes the row (idempotent)
    await backend.upsert(pending);
    await backend.upsert({ ...pending, status: 'approved', approvedBy: 'm' });
    expect(await backend.get('ap-pg-1')).toMatchObject({ status: 'pending' });

    // a decision is made through resolve (the only status-flip path)
    expect(await backend.resolve('ap-pg-1', 'm', 'approved')).toBe(true);
    // a resolved decision is never resurrected by a re-pending upsert
    await backend.upsert({ ...pending, status: 'pending' });

    const got = await backend.get('ap-pg-1');
    expect(got).toMatchObject({
      approvalKey: 'ap-pg-1',
      action: 'mcp.tool.x',
      args: { a: 1, b: [2, 3] },
      actorKey: 'agent-1',
      status: 'approved',
      approvedBy: 'm',
    });
    expect(got!.createdAt).toBeInstanceOf(Date);

    // list + count honor the filter
    expect(await backend.count({ status: 'approved' })).toBe(1);
    expect(await backend.list({ action: 'mcp.tool.x' })).toHaveLength(1);
    expect(await backend.list({ action: 'nope' })).toHaveLength(0);

    // resolve on a fresh pending row
    const pending2: PendingApproval = {
      approvalKey: 'ap-pg-2',
      action: 'mcp.tool.y',
      args: {},
      status: 'pending',
      createdAt: new Date('2026-09-01T10:00:00Z'),
      actorKey: 'agent-1',
    };
    await backend.upsert(pending2);
    expect(await backend.resolve('ap-pg-2', 'manager', 'rejected')).toBe(true);
    expect(await backend.resolve('ap-pg-2', 'manager', 'approved')).toBe(false);
    const rejected = await backend.get('ap-pg-2');
    expect(rejected).toMatchObject({ status: 'rejected', approvedBy: 'manager' });
  });

  it('Time range filtering', async () => {
    const backend = await createApprovalsBackend(pool);
    const within = await backend.list({
      from: new Date('2026-08-31T00:00:00Z'),
      to: new Date('2026-08-31T23:59:59Z'),
    });
    expect(within.map((e) => e.approvalKey)).toContain('ap-pg-1');
    expect(within.map((e) => e.approvalKey)).not.toContain('ap-pg-2');
  });

  after(async () => {
    await pool.query('DROP TABLE IF EXISTS weavekit_approvals CASCADE');
    await pool.end();
  });
});
