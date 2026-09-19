import { describe, it, expect } from '../helpers/test.js';
import type { Pool } from 'pg';
import { createApprovalsPgStore } from '../../src/subsystems/approvals/store.js';
import type { PendingApproval } from '../../src/core/tools/types.js';

interface Captured {
  text: string;
  values: unknown[];
}

type PoolHandler = (text: string, values: unknown[]) => { rows?: unknown[]; rowCount?: number };

function fakePool(handler: PoolHandler): { pool: Pool; calls: Captured[] } {
  const calls: Captured[] = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return handler(text, values);
    },
  } as unknown as Pool;
  return { pool, calls };
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  approval_key: 'ap-1',
  action: 'mcp.tool.x',
  args: { a: 1 },
  actor_key: 'agent-1',
  status: 'pending',
  created_at: '2026-08-31T10:00:00Z',
  approved_by: null,
  ...over,
});

describe('createApprovalsPgStore', () => {
  it('maps a row to PendingApproval (args parsed, actorKey present)', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [row({ approved_by: 'manager' })] }));
    const store = createApprovalsPgStore(pool);

    const entry = await store.get('ap-1');
    expect(calls[0]!.text).toContain('WHERE approval_key = $1');
    expect(calls[0]!.values).toEqual(['ap-1']);
    expect(entry).toMatchObject({
      approvalKey: 'ap-1',
      action: 'mcp.tool.x',
      args: { a: 1 },
      actorKey: 'agent-1',
      status: 'pending',
      approvedBy: 'manager',
    });
    expect(entry!.createdAt).toBeInstanceOf(Date);
  });

  it('list builds a parameterized WHERE with limit/offset and maps rows', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [row(), row({ approval_key: 'ap-2' })] }));
    const store = createApprovalsPgStore(pool);

    const entries = await store.list({
      status: 'pending',
      action: 'mcp.tool.x',
      actorKey: 'agent-1',
      from: new Date('2026-08-01T00:00:00Z'),
      limit: 25,
      offset: 50,
      sort: { field: 'createdAt', order: 'DESC' },
    });
    expect(calls[0]!.text).toMatch(/WHERE status = \$1 AND action = \$2 AND actor_key = \$3 AND created_at >= \$4/);
    expect(calls[0]!.text).toMatch(/ORDER BY created_at DESC[\s\S]*LIMIT \$\d+ OFFSET \$\d+/);
    expect(entries).toHaveLength(2);
  });

  it('upsert JSON-stringifies args with ON CONFLICT DO NOTHING (deterministic dedup)', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    const store = createApprovalsPgStore(pool);
    const entry: PendingApproval = {
      approvalKey: 'ap-1',
      action: 'mcp.tool.x',
      args: { a: 1, b: [2, 3] },
      status: 'pending',
      createdAt: new Date('2026-08-31T10:00:00Z'),
      actorKey: 'agent-1',
    };
    await store.upsert(entry);

    expect(calls[0]!.text).toContain('ON CONFLICT (approval_key) DO NOTHING');
    expect(calls[0]!.values[2]).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
    expect(calls[0]!.values[5]).toBe(entry.createdAt);
  });

  it('resolve only flips a pending row and reports the rowCount', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 1 }));
    const store = createApprovalsPgStore(pool);

    await expect(store.resolve('ap-1', 'manager', 'approved')).resolves.toBe(true);
    expect(calls[0]!.text).toContain("WHERE approval_key = $1 AND status = 'pending'");
    expect(calls[0]!.values).toEqual(['ap-1', 'approved', 'manager']);
  });

  it('count returns the aggregate n', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ n: 7 }] }));
    const store = createApprovalsPgStore(pool);

    await expect(store.count({ status: 'pending' })).resolves.toBe(7);
    expect(calls[0]!.text).toContain('SELECT count(*)::int AS n');
    expect(calls[0]!.text).toContain('WHERE status = $1');
  });
});
