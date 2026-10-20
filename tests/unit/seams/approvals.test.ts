import { describe, it, expect } from '../../helpers/test.js';
import { createMemoryApprovalsBackend, type ApprovalsBackend, type PendingApproval } from '../../../src/core/index.js';
import { createApprovals } from '../../../src/runtime/tools/index.js';
import type { ApprovalEvent } from '../../../src/core/index.js';
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
  it('upsert/get round-trips and is create-only by key', async () => {
    const backend = createMemoryApprovalsBackend();
    await backend.upsert(entry({ approvalKey: 'a', status: 'pending' }));
    await backend.upsert(entry({ approvalKey: 'a', status: 'approved', approvedBy: 'admin' }));
    const pending = await backend.get('a');
    expect(pending?.status).toBe('pending');
    expect(await backend.resolve('a', 'admin', 'approved')).toBe(true);
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
    expect(events.length).toBe(2);
    expect(events[0]?.action).toBe('approval.requested');
    expect(events[1]?.action).toBe('approval.approved');
    expect(events[1]?.actorId).toBe('admin');
    expect((events[1]?.meta as { status?: string }).status).toBe('approved');
  });
});
describe('approval single-use, expiry and context', () => {
  const capture = (): { sink: AuditSink; events: AuditEvent[] } => {
    const events: AuditEvent[] = [];
    return { events, sink: { record: async (e) => void events.push(e), recordBatch: async () => {} } };
  };

  it('consume is single-use and audits requested/approved/consumed', async () => {
    const { sink, events } = capture();
    const approvals = createApprovals({ audit: sink, ttlMs: 60_000 });
    await approvals.pending(
      'mcp.tool.delete_record',
      { id: 'X' },
      { key: 'agent-1', label: 'agent', onBehalfOf: 'u1' },
      'ap-consume',
      { requestedBy: 'u1', requestId: 'req-1', policy: { ruleId: 'r1', reason: 'demo' } },
    );
    const [pending] = await approvals.query('pending');
    expect(pending?.requestedBy).toBe('u1');
    expect(pending?.onBehalfOf).toBe('u1');
    expect(pending?.policy?.ruleId).toBe('r1');
    expect(pending?.requestHash).toBeTruthy();
    expect(pending?.expiresAt).toBeInstanceOf(Date);

    expect(await approvals.approve('ap-consume', 'mgr', 'looks good')).toBe(true);
    expect(await approvals.consume('ap-consume', 'u1')).toBe(true);
    expect(await approvals.consume('ap-consume', 'u1')).toBe(false);
    expect((await approvals.query('approved'))[0]?.comment).toBe('looks good');
    expect(events.map((event) => event.action)).toEqual([
      'approval.requested',
      'approval.approved',
      'approval.consumed',
    ]);
  });

  it('expired approvals cannot be resolved or consumed', async () => {
    const approvals = createApprovals({ ttlMs: 1 });
    await approvals.pending('mcp.tool.x', {}, { key: 'agent-1', label: 'agent', onBehalfOf: 'u1' }, 'ap-exp');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await approvals.approve('ap-exp', 'mgr')).toBe(false);
    expect(await approvals.consume('ap-exp', 'u1')).toBe(false);
  });
});
  it('enforces segregation of duties (requester cannot decide)', async () => {
    const approvals = createApprovals();
    await approvals.pending(
      'mcp.tool.x',
      {},
      { key: 'agent-1', label: 'agent', onBehalfOf: 'u1' },
      'ap-sod',
      { requestedBy: 'u1' },
    );
    expect(await approvals.approve('ap-sod', 'u1')).toBe(false);
    expect(await approvals.reject('ap-sod', 'u1', 'self')).toBe(false);
    expect(await approvals.approve('ap-sod', 'mgr')).toBe(true);
  });
describe('approval lifecycle event sink', () => {
  it('emits requested/approved/consumed without blocking', async () => {
    const emitted: ApprovalEvent[] = [];
    const approvals = createApprovals({
      ttlMs: 60_000,
      events: { emit: (event) => void emitted.push(event) },
    });
    await approvals.pending(
      'mcp.tool.delete_record',
      { id: 'X' },
      { key: 'agent-1', label: 'agent', onBehalfOf: 'u1' },
      'ap-events',
      { requestedBy: 'u1', requestId: 'req-1', policy: { ruleId: 'r1' } },
    );
    expect(await approvals.approve('ap-events', 'mgr', 'ok')).toBe(true);
    expect(await approvals.consume('ap-events', 'u1')).toBe(true);
    expect(emitted.map((event) => event.type)).toEqual([
      'approval.requested',
      'approval.approved',
      'approval.consumed',
    ]);
    expect(emitted[0]).toMatchObject({
      approvalKey: 'ap-events',
      requestedBy: 'u1',
      onBehalfOf: 'u1',
      policy: { ruleId: 'r1' },
    });
    expect(emitted[1]).toMatchObject({ approver: 'mgr', comment: 'ok' });
    expect(emitted[2]).toMatchObject({ approver: 'u1' });
  });
});
describe('quorum voting', () => {
  it('stays pending until requiredApprovals and is idempotent per approver', async () => {
    const backend = createMemoryApprovalsBackend();
    await backend.upsert(entry({ approvalKey: 'q1', requestedBy: 'maya', requiredApprovals: 2, approvedCount: 0 }));
    expect(
      await backend.vote!('q1', {
        approvalKey: 'q1',
        approver: 'jonas',
        decision: 'approved',
        createdAt: new Date(),
      }),
    ).toBe(true);
    expect((await backend.get('q1'))?.status).toBe('pending');
    expect((await backend.get('q1'))?.approvedCount).toBe(1);
    // duplicate vote is idempotent
    expect(
      await backend.vote!('q1', {
        approvalKey: 'q1',
        approver: 'jonas',
        decision: 'approved',
        createdAt: new Date(),
      }),
    ).toBe(true);
    expect((await backend.votes!('q1')).length).toBe(1);
    expect(
      await backend.vote!('q1', {
        approvalKey: 'q1',
        approver: 'ada',
        decision: 'approved',
        createdAt: new Date(),
      }),
    ).toBe(true);
    const approved = await backend.get('q1');
    expect(approved?.status).toBe('approved');
    expect(approved?.approvedCount).toBe(2);
  });

  it('rejects immediately and refuses the requester', async () => {
    const backend = createMemoryApprovalsBackend();
    await backend.upsert(entry({ approvalKey: 'q2', requestedBy: 'maya', requiredApprovals: 2 }));
    expect(
      await backend.vote!('q2', {
        approvalKey: 'q2',
        approver: 'maya',
        decision: 'approved',
        createdAt: new Date(),
      }),
    ).toBe(false);
    expect(
      await backend.vote!('q2', {
        approvalKey: 'q2',
        approver: 'jonas',
        decision: 'rejected',
        comment: 'no',
        createdAt: new Date(),
      }),
    ).toBe(true);
    const rejected = await backend.get('q2');
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejectedBy).toBe('jonas');
    expect(rejected?.comment).toBe('no');
  });
});