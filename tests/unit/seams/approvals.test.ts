import { describe, it, expect } from '../../helpers/test.js';
import { createMemoryApprovalsBackend, type ApprovalsBackend, type PendingApproval } from '../../../src/core/index.js';
import { createApprovals } from '../../../src/runtime/tools/index.js';
import type { AuditEvent, AuditSink } from '../../../src/core/audit/index.js';

/**
 * `ApprovalsBackend` + approval queue seam contract: upsert/get/resolve
 * idempotency, filter semantics, and resolution auditing (the queue audits;
 * the backend never does).
 */

const entry = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  approvalKey: 'ap-1',
  action: 'mcp.tool.delete_record',
  args: { object: 'lead', id: 'X' },
  status: 'pending',
  createdAt: new Date(),
  actorKey: 'agent-1',
  ...over,
});

describe('ApprovalsBackend seam contract', () => {
  it('upsert/get round-trips and replaces by key', async () => {
    const backend = createMemoryApprovalsBackend();
    await backend.upsert(entry({ approvalKey: 'a', status: 'pending' }));
    await backend.upsert(entry({ approvalKey: 'a', status: 'approved', approvedBy: 'admin' }));
    const got = await backend.get('a');
    expect(got?.status).toBe('approved');
    expect(got?.approvedBy).toBe('admin');
    expect(await backend.count()).toBe(1);
  });

  it('resolve is idempotent: only a pending entry transitions (second resolve → false)', async () => {
    const backend = createMemoryApprovalsBackend();
    await backend.upsert(entry({ approvalKey: 'a' }));
    expect(await backend.resolve('a', 'admin', 'approved')).toBe(true);
    expect(await backend.resolve('a', 'admin', 'rejected')).toBe(false);
    expect((await backend.get('a'))?.status).toBe('approved');
  });

  it('resolve of an unknown key → false (never throws)', async () => {
    const backend = createMemoryApprovalsBackend();
    expect(await backend.resolve('missing', 'admin', 'approved')).toBe(false);
  });

  it('count/list honour status + action filters', async () => {
    const backend = createMemoryApprovalsBackend();
    await backend.upsert(entry({ approvalKey: 'a', action: 'act.one', status: 'pending' }));
    await backend.upsert(entry({ approvalKey: 'b', action: 'act.two', status: 'pending' }));
    await backend.resolve('b', 'admin', 'approved');
    expect(await backend.count({ status: 'pending' })).toBe(1);
    expect((await backend.list({ action: 'act.one' })).map((e) => e.approvalKey)).toEqual(['a']);
  });
});

describe('approval queue facade contract (audits resolution)', () => {
  const capture = (): { sink: AuditSink; events: AuditEvent[] } => {
    const events: AuditEvent[] = [];
    return { events, sink: { record: async (e) => void events.push(e), recordBatch: async () => {} } };
  };

  it('approve() audits the resolution and returns idempotently', async () => {
    const { sink, events } = capture();
    const backend: ApprovalsBackend = createMemoryApprovalsBackend();
    const approvals = createApprovals({ backend, audit: sink });
    await approvals.pending('act.del', { id: 'X' }, { key: 'agent-1', label: 'agent', onBehalfOf: 'u1' }, 'ap-x');
    expect(await approvals.approve('ap-x', 'admin')).toBe(true);
    expect(await approvals.approve('ap-x', 'admin')).toBe(false); // not pending anymore
    expect(events.length).toBe(1);
    expect(events[0]?.actorId).toBe('admin');
    expect((events[0]?.meta as { status?: string }).status).toBe('approved');
  });
});
