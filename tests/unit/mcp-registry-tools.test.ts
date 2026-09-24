import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry } from '../../src/core/object/registry.js';
import {
  createRecordHandler,
  deleteRecordHandler,
  getRecordHandler,
  searchRecordsHandler,
  updateRecordHandler,
  workflowTransitionHandler,
} from '../../src/adapters/mcp/tools.js';
import { REGISTRY_TOOLS, WORKFLOW_TOOLS } from '../../src/core/index.js';
import type { McpEngine, ToolExecContext } from '../../src/adapters/mcp/types.js';
import type { ObjectDefinition, RbacSubject } from '../../src/core/index.js';
import type { AuditEvent } from '../../src/core/audit/index.js';

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
  ],
};

const TICKET: ObjectDefinition = {
  name: 'ticket',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'status', type: 'enum', options: ['draft', 'open'] },
  ],
  workflow: {
    initial: 'draft',
    stateField: 'status',
    states: [{ name: 'draft' }, { name: 'open' }],
    transitions: [{ action: 'open', from: 'draft', to: 'open' }],
  },
  permissions: { sales: { read: 'all', update: true } },
};

interface Call {
  method: string;
  object: string;
  args: unknown;
}

interface Harness {
  ctx: ToolExecContext;
  calls: Call[];
  audits: AuditEvent[];
}

function harness(options: { rateOk?: boolean } = {}): Harness {
  const calls: Call[] = [];
  const audits: AuditEvent[] = [];
  const registry = new ObjectRegistry();
  registry.register(LEAD);
  registry.register(TICKET);
  registry.buildGraph();

  const dataAccess = {
    async find(object: string, opts: unknown) {
      calls.push({ method: 'find', object, args: opts });
      return { rows: [{ id: 'L1', name: 'Acme' }], total: 1 };
    },
    async findOne(object: string, id: string) {
      calls.push({ method: 'findOne', object, args: id });
      return id === 'L1' ? { id: 'L1', name: 'Acme' } : null;
    },
    async create(object: string, data: unknown) {
      calls.push({ method: 'create', object, args: data });
      return { id: 'L9', ...(data as Record<string, unknown>) };
    },
    async update(object: string, id: string, changes: unknown) {
      calls.push({ method: 'update', object, args: { id, changes } });
      return { id, ...(changes as Record<string, unknown>) };
    },
    async delete(object: string, id: string) {
      calls.push({ method: 'delete', object, args: id });
    },
    async transition(object: string, id: string, action: string) {
      calls.push({ method: 'transition', object, args: { id, action } });
      return { id, status: 'open' };
    },
  };

  const engine: McpEngine = { registry, pool: {} as never, dataAccess: dataAccess as never, locale: 'en' };
  const user: RbacSubject = { id: 'u1', roles: ['sales'] };
  const ctx: ToolExecContext = {
    engine,
    session: {
      id: 's1',
      agentKey: 'key-1',
      agentSubject: { id: 'agent', roles: ['agent'] },
      user,
      onBehalfOf: 'alice',
      createdAt: new Date(),
      lastActivity: new Date(),
    },
    guardrails: {
      checkRateLimit: () => options.rateOk ?? true,
      audit: (event: AuditEvent) => {
        audits.push(event);
        return Promise.resolve();
      },
    } as never,
    resolveIdentity: async () => user,
  };
  return { ctx, calls, audits };
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

describe('registry tool handlers — object resolution + RBAC-delegated dispatch', () => {
  it('search resolves the object, delegates to find, and audits the generic tool name', async () => {
    const { ctx, calls, audits } = harness();
    const result = await searchRecordsHandler({ object: 'lead', limit: 10 }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ method: 'find', object: 'lead' });
    expect(JSON.parse(textOf(result)).total).toBe(1);
    expect(audits[0]!.action).toBe(`mcp.tool.${REGISTRY_TOOLS.SEARCH}`);
    expect(audits[0]!.objectName).toBe('lead');
    expect(audits[0]!.isError).toBe(false);
  });

  it('unknown object → isError (data.objectUnknown), audited, no data-access call', async () => {
    const { ctx, calls, audits } = harness();
    const result = await getRecordHandler({ object: 'nope', id: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(audits[0]!.errorCode).toBe('data.objectUnknown');
  });

  it('get / create / update / delete route to the matching data-access method', async () => {
    const { ctx, calls } = harness();
    await getRecordHandler({ object: 'lead', id: 'L1' }, ctx);
    await createRecordHandler({ object: 'lead', data: { name: 'New' } }, ctx);
    await updateRecordHandler({ object: 'lead', id: 'L1', changes: { name: 'X' } }, ctx);
    await deleteRecordHandler({ object: 'lead', id: 'L1' }, ctx);
    expect(calls.map((c) => c.method)).toEqual(['findOne', 'create', 'update', 'delete']);
    expect(calls.every((c) => c.object === 'lead')).toBe(true);
  });

  it('get on a missing row → isError (data.recordNotFound)', async () => {
    const { ctx } = harness();
    const result = await getRecordHandler({ object: 'lead', id: 'L404' }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('L404');
  });

  it('rate limit is checked before the object is touched', async () => {
    const { ctx, calls, audits } = harness({ rateOk: false });
    const result = await searchRecordsHandler({ object: 'lead' }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(audits[0]!.errorCode).toBe('mcp.rateLimited');
  });

  it('workflow_transition delegates to data-access.transition and audits the tool', async () => {
    const { ctx, calls, audits } = harness();
    const result = await workflowTransitionHandler({ object: 'ticket', id: 'T1', action: 'open' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ method: 'transition', object: 'ticket', args: { id: 'T1', action: 'open' } });
    expect(audits[0]!.action).toBe(`mcp.tool.${WORKFLOW_TOOLS.TRANSITION}`);
    expect(audits[0]!.objectName).toBe('ticket');
    expect(audits[0]!.isError).toBe(false);
  });

  it('workflow_transition on an object without a workflow → isError (workflow.transition.unknown)', async () => {
    const { ctx, calls, audits } = harness();
    const result = await workflowTransitionHandler({ object: 'lead', id: 'L1', action: 'open' }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(audits[0]!.errorCode).toBe('workflow.transition.unknown');
  });
});
