import { describe, it, expect } from '../helpers/test.js';
import { SchemaError, EXECUTION_STAGES, type Evidence } from '../../src/core/index.js';
import { runPipeline } from '../../src/runtime/execution/index.js';

const subject = { id: 'u1', roles: ['agent'] };
const actor = { key: 'cred', label: 'agent', onBehalfOf: 'alice' };
const ctx = { actor, subject };
const plan = { action: 'object.lead.create', args: {} };

function capturingSink() {
  const events: Evidence[] = [];
  return { events, sink: { record: async (e: Evidence) => { events.push(e); } } };
}

describe('runPipeline', () => {
  it('ok: runs execute and records all stages', async () => {
    const { events, sink } = capturingSink();
    let executed = 0;
    const res = await runPipeline(plan, ctx, {
      gate: async () => ({ kind: 'allow' }),
      execute: async () => { executed += 1; return { done: true }; },
      evidence: sink,
    });
    expect(res.outcome).toBe('ok');
    expect(res.result).toEqual({ done: true });
    expect(executed).toBe(1);
    expect(events[0]!.isError).toBe(false);
    const stages = events[0]!.stages.map((s) => s.stage);
    expect(stages).toContain(EXECUTION_STAGES.PLAN);
    expect(stages).toContain(EXECUTION_STAGES.EXECUTE);
    expect(stages).toContain(EXECUTION_STAGES.EVIDENCE);
  });

  it('deny: gate short-circuits execute', async () => {
    const { events, sink } = capturingSink();
    let executed = 0;
    const res = await runPipeline(plan, ctx, {
      gate: async () => ({ kind: 'deny', reason: 'nope', errorCode: 'mcp.policy.denied' }),
      execute: async () => { executed += 1; },
      evidence: sink,
    });
    expect(res.outcome).toBe('deny');
    expect(res.errorCode).toBe('mcp.policy.denied');
    expect(executed).toBe(0);
    expect(events[0]!.isError).toBe(true);
  });

  it('pending: records an approval key and does not execute', async () => {
    let executed = 0;
    const res = await runPipeline(plan, ctx, {
      gate: async () => ({ kind: 'pending', approvalKey: 'ap-1' }),
      execute: async () => { executed += 1; },
    });
    expect(res.outcome).toBe('pending');
    expect(res.approvalKey).toBe('ap-1');
    expect(executed).toBe(0);
  });

  it('error: an execute throw is captured, not rethrown', async () => {
    const { events, sink } = capturingSink();
    const res = await runPipeline(plan, ctx, {
      execute: async () => { throw new SchemaError('data.unique', { object: 'lead' }); },
      evidence: sink,
    });
    expect(res.outcome).toBe('error');
    expect(res.errorCode).toBe('data.unique');
    expect(events[0]!.errorCode).toBe('data.unique');
  });

  it('validate: a throwing validator denies before the gate/execute', async () => {
    let gated = 0;
    let executed = 0;
    const res = await runPipeline(plan, ctx, {
      validate: async () => { throw new SchemaError('tool.args.invalid', { tool: 'x', detail: 'bad' }); },
      gate: async () => { gated += 1; return { kind: 'allow' as const }; },
      execute: async () => { executed += 1; },
    });
    expect(res.outcome).toBe('deny');
    expect(res.errorCode).toBe('tool.args.invalid');
    expect(gated).toBe(0);
    expect(executed).toBe(0);
  });

  it('a throwing gate is fail-closed (deny)', async () => {
    const res = await runPipeline(plan, ctx, {
      gate: async () => { throw new Error('boom'); },
      execute: async () => 'nope',
    });
    expect(res.outcome).toBe('deny');
    expect(res.errorCode).toBe('mcp.policy.denied');
  });
});
