import { describe, it, expect } from '../helpers/test.js';
import { approvalKeyFor, createApprovals, createToolExecutor } from '../../src/runtime/tools/index.js';
import type { AuditSink, AuditEvent, RbacSubject, ToolActor, ToolDefinition, ToolResult } from '../../src/core/index.js';

const subject: RbacSubject = { id: 'u-alice', roles: ['agent', 'admin'] };
const agent: RbacSubject = { id: 'u-bob', roles: ['agent'] };
const actor: ToolActor = { key: 'key-1', label: 'agent-1', onBehalfOf: 'alice' };

function makeDataAccess(calls: string[]) {
  return {
    find: async (n: string) => {
      calls.push(`find:${n}`);
      return { rows: [], total: 0 };
    },
    findOne: async (n: string, id: string) => {
      calls.push(`findOne:${n}:${id}`);
      return null;
    },
    create: async (n: string, d: Record<string, unknown>) => {
      calls.push(`create:${n}`);
      return { id: 'r1', ...d };
    },
    update: async (n: string, id: string, ch: Record<string, unknown>) => {
      calls.push(`update:${n}:${id}`);
      return { id, ...ch };
    },
    delete: async (n: string, id: string) => {
      calls.push(`delete:${n}:${id}`);
    },
  };
}

function fakePool() {
  const client = {
    query: async () => ({ rows: [] }),
    release: () => {},
  };
  return { connect: async () => client } as never;
}

function makeExecutor(options?: { audit?: AuditSink; dataAccess?: ReturnType<typeof makeDataAccess>; pool?: never }) {
  const calls: string[] = [];
  const dataAccess = options?.dataAccess ?? makeDataAccess(calls);
  const executor = createToolExecutor({
    dataAccess: dataAccess as never,
    pool: options?.pool ?? fakePool(),
    registry: {} as never,
    audit: options?.audit,
    guardrails: { checkRateLimit: () => true },
  });
  return { executor, calls, dataAccess };
}

const ticker: ToolDefinition = {
  name: 'reassign_ticket',
  description: 'Transfer a ticket',
  inputSchema: { type: 'object', properties: {} },
  roles: ['agent', 'admin'],
  handler: async (ctx) => {
    await ctx.dataAccess.findOne('ticket', 't1', { subject: ctx.subject });
    return { content: [{ type: 'text', text: 'done' }] };
  },
};

describe('ToolExecutor.surface — roles whitelist filtering + D8 cache', () => {
  it('roles hit or missing → visible; unlisted role → invisible', () => {
    const { executor } = makeExecutor();
    const customer: RbacSubject = { id: 'u-eve', roles: ['customer'] };
    const visible = (s: RbacSubject) => executor.surface(s, [ticker]).map((t) => t.name);
    expect(visible(subject)).toEqual(['reassign_ticket']);
    expect(visible(agent)).toEqual(['reassign_ticket']);
    expect(visible(customer)).toEqual([]);
    const noRoles: ToolDefinition = { ...ticker, roles: undefined };
    expect(executor.surface(subject, [noRoles])).toHaveLength(1);
  });

  it('same subject + tool set → cache hit returns same array reference', () => {
    const { executor } = makeExecutor();
    const a = executor.surface(subject, [ticker]);
    const b = executor.surface(subject, [ticker]);
    expect(a).toBe(b);
  });
});

describe('ToolExecutor.execute — controlled ctx + automatic audit + error mapping', () => {
  it('ctx injects dataAccess/subject/actor/audit/approvals/withTx', async () => {
    let seen: unknown;
    const tool: ToolDefinition = {
      name: 'probe',
      description: 'x',
      inputSchema: { type: 'object' },
      handler: async (ctx) => {
        seen = {
          subject: ctx.subject,
          actor: ctx.actor,
          args: ctx.args,
          action: ctx.action,
          hasDataAccess: typeof ctx.dataAccess.find === 'function',
          hasAudit: typeof ctx.audit.record === 'function',
          hasApprovals: typeof ctx.approvals.query === 'function',
          hasWithTx: typeof ctx.withTx === 'function',
        };
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const { executor } = makeExecutor();
    await executor.execute(tool, {}, { subject, actor, action: 'mcp.tool.probe', args: { ticket_id: 't1' } });
    expect(seen).toMatchObject({ subject, actor, args: { ticket_id: 't1' }, action: 'mcp.tool.probe', hasDataAccess: true, hasAudit: true, hasApprovals: true, hasWithTx: true });
  });

  it('automatic audit mcp.tool.<name> (actorId=actor.key + meta)', async () => {
    const events: AuditEvent[] = [];
    const audit: AuditSink = { record: async (e) => { events.push(e); } };
    const { executor } = makeExecutor({ audit });
    await executor.execute(ticker, { ticket_id: 't1' }, { subject, actor, action: 'mcp.tool.reassign_ticket', args: { ticket_id: 't1' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'mcp.tool.reassign_ticket',
      actorId: 'key-1',
      isError: false,
      objectName: undefined,
      changes: { ticket_id: 't1' },
    });
    expect(events[0]!.meta).toMatchObject({ onBehalfOf: 'alice', subjectId: 'u-alice', tool: 'reassign_ticket' });
  });

  it('handler throws → isError result + audit isError', async () => {
    const events: AuditEvent[] = [];
    const audit: AuditSink = { record: async (e) => { events.push(e); } };
    const boom: ToolDefinition = {
      name: 'boom',
      description: 'x',
      inputSchema: { type: 'object' },
      handler: async () => {
        throw new Error('nope');
      },
    };
    const { executor } = makeExecutor({ audit });
    const result = await executor.execute(boom, {}, { subject, actor, action: 'mcp.tool.boom', args: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe('nope');
    expect(events[0]).toMatchObject({ isError: true, action: 'mcp.tool.boom' });
  });

  it('handler reaches RBAC-wrapped instance via ctx.dataAccess', async () => {
    const { executor, calls } = makeExecutor();
    await executor.execute(ticker, {}, { subject, actor, action: 'mcp.tool.reassign_ticket', args: {} });
    expect(calls).toEqual(['findOne:ticket:t1']);
  });

  it('ctx.withTx available (transaction primitive wired up)', async () => {
    const tool: ToolDefinition = {
      name: 'tx_tool',
      description: 'x',
      inputSchema: { type: 'object' },
      handler: async (ctx) => {
        const r = await ctx.withTx(async (tx) => {
          await tx.dataAccess.create('ticket', { subject: 'x' }, { subject: ctx.subject });
          return 'committed';
        });
        return { content: [{ type: 'text', text: r }] };
      },
    };
    const { executor, calls } = makeExecutor();
    const result = await executor.execute(tool, {}, { subject, actor, action: 'mcp.tool.tx_tool', args: {} });
    expect(result.content[0]?.text).toBe('committed');
    expect(calls).toContain('create:ticket');
  });
});

describe('approvalKeyFor / createApprovals — deterministic keys and queue', () => {
  it('approvalKeyFor is deterministic for identical input', async () => {
    expect(approvalKeyFor(actor, 'mcp.tool.x', { a: 1 })).toBe(approvalKeyFor(actor, 'mcp.tool.x', { a: 1 }));
    expect(approvalKeyFor(actor, 'mcp.tool.x', { a: 1 })).not.toBe(approvalKeyFor(actor, 'mcp.tool.x', { a: 2 }));
  });

  it('queue query/approve/reject lifecycle', async () => {
    const approvals = createApprovals();
    await approvals.pending('mcp.tool.x', { a: 1 }, actor);
    const [entry] = await approvals.query('pending');
    expect(entry).toBeDefined();
    expect(await approvals.approve(entry!.approvalKey, 'manager')).toBe(true);
    expect(await approvals.approve(entry!.approvalKey, 'manager')).toBe(false); // already approved, cannot repeat
    expect(await approvals.query('approved')).toHaveLength(1);
    const [approved] = await approvals.query('approved');
    expect(approved?.approvedBy).toBe('manager');
    expect(await approvals.reject('missing-key', 'm')).toBe(false);
  });
});

/** keep ToolResult import used for typing completeness */
void (null as unknown as ToolResult);
