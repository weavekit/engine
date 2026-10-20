import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry } from '../../src/core/object/registry.js';
import { compileToolsFor } from '../../src/adapters/mcp/generate.js';
import {
  approveApprovalHandler,
  listApprovalsHandler,
  rejectApprovalHandler,
} from '../../src/adapters/mcp/approvals.js';
import { APPROVAL_TOOLS } from '../../src/core/index.js';
import type { McpEngine, ToolExecContext } from '../../src/adapters/mcp/types.js';
import type { IdentitySubject } from '../../src/core/index.js';
import type { ToolApprovals, PendingApproval } from '../../src/core/tools/types.js';
import type { AuditEvent } from '../../src/core/audit/index.js';

const QUEUE: PendingApproval[] = [
  {
    approvalKey: 'ap-1',
    action: 'object.lead.update',
    args: { id: 'L1' },
    status: 'pending',
    createdAt: new Date('2026-10-11T10:00:00Z'),
    actorKey: 'agent-1',
  },
];

interface Harness {
  ctx: ToolExecContext;
  audits: AuditEvent[];
}

function fakeApprovals(): { approvals: ToolApprovals; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    approvals: {
      list: async (filter) => {
        calls.push(`list:${filter?.status ?? ''}`);
        return filter?.status === 'approved' ? [] : QUEUE;
      },
      count: async () => QUEUE.length,
      query: async () => QUEUE,
      approve: async (key) => {
        calls.push(`approve:${key}`);
        return key === 'ap-1';
      },
      reject: async (key) => {
        calls.push(`reject:${key}`);
        return key === 'ap-1';
      },
      vote: async (key) => {
        calls.push(`vote:${key}`);
        return key === 'ap-1';
      },
      votes: async () => [],
    },
  };
}

function harness(options: { roles: string[]; withQueue?: boolean }): Harness {
  const audits: AuditEvent[] = [];
  const registry = new ObjectRegistry();
  const { approvals } = fakeApprovals();
  const engine: McpEngine = {
    registry,
    pool: {} as never,
    dataAccess: {} as never,
    locale: 'en',
    ...(options.withQueue === false ? {} : { approvals }),
    adminRoles: ['admin'],
  };
  const user: IdentitySubject = { id: 'u1', roles: options.roles };
  const ctx: ToolExecContext = {
    engine,
    session: {
      id: 's1',
      agentCredentialId: 'key-1',
      agentSubject: { id: 'agent', roles: ['agent'] },
      user,
      onBehalfOf: 'alice',
      createdAt: new Date(),
      lastActivity: new Date(),
    },
    guardrails: {
      checkRateLimit: () => true,
      audit: (event: AuditEvent) => {
        audits.push(event);
        return Promise.resolve();
      },
    } as never,
    resolveIdentity: async () => user,
    allowImpersonation: false,
  };
  return { ctx, audits };
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

describe('compileToolsFor — approval tools surface gating', () => {
  it('exposes the approval tools to an admin when a queue is wired', () => {
    const { ctx } = harness({ roles: ['admin'] });
    const names = compileToolsFor(ctx.engine, ctx.session.user).map((t) => t.spec.name);
    expect(names).toContain(APPROVAL_TOOLS.LIST);
    expect(names).toContain(APPROVAL_TOOLS.APPROVE);
    expect(names).toContain(APPROVAL_TOOLS.REJECT);
  });

  it('hides the approval tools from a non-admin', () => {
    const { ctx } = harness({ roles: ['viewer'] });
    const names = compileToolsFor(ctx.engine, ctx.session.user).map((t) => t.spec.name);
    expect(names).not.toContain(APPROVAL_TOOLS.LIST);
  });

  it('hides the approval tools when no queue is wired', () => {
    const { ctx } = harness({ roles: ['admin'], withQueue: false });
    const names = compileToolsFor(ctx.engine, ctx.session.user).map((t) => t.spec.name);
    expect(names).not.toContain(APPROVAL_TOOLS.LIST);
  });
});

describe('approval tool handlers', () => {
  it('list returns rows + total for an admin', async () => {
    const { ctx, audits } = harness({ roles: ['admin'] });
    const result = await listApprovalsHandler({ status: 'pending' }, ctx);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result)) as { rows: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.rows).toHaveLength(1);
    expect(audits[0]!.action).toBe(`mcp.tool.${APPROVAL_TOOLS.LIST}`);
    expect(audits[0]!.isError).toBe(false);
  });

  it('approve resolves the entry as the authenticated subject', async () => {
    const { ctx } = harness({ roles: ['admin'] });
    const result = await approveApprovalHandler({ key: 'ap-1' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({ approvalKey: 'ap-1', status: 'approved', approver: 'u1' });
  });

  it('reject resolves the entry as rejected', async () => {
    const { ctx } = harness({ roles: ['admin'] });
    const result = await rejectApprovalHandler({ key: 'ap-1' }, ctx);
    expect(JSON.parse(textOf(result))).toMatchObject({ approvalKey: 'ap-1', status: 'rejected' });
  });

  it('approve on a missing entry → isError (approval.notFound)', async () => {
    const { ctx, audits } = harness({ roles: ['admin'] });
    const result = await approveApprovalHandler({ key: 'missing' }, ctx);
    expect(result.isError).toBe(true);
    expect(audits[0]!.errorCode).toBe('approval.notFound');
  });

  it('non-admin is denied at execution too (rbac.denied.update)', async () => {
    const { ctx, audits } = harness({ roles: ['viewer'] });
    const result = await listApprovalsHandler({}, ctx);
    expect(result.isError).toBe(true);
    expect(audits[0]!.errorCode).toBe('rbac.denied.update');
  });

  it('invalid status → isError (http.param.invalid)', async () => {
    const { ctx } = harness({ roles: ['admin'] });
    const result = await listApprovalsHandler({ status: 'bogus' }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('status');
  });
});
