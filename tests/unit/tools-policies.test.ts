import { describe, it, expect } from '../helpers/test.js';
import { evaluatePolicies } from '../../src/core/index.js';
import { applyMask, evaluateCall, evaluateTransition } from '../../src/runtime/tools/policies.js';
import type { ApprovalStatus, GuardrailContext, GuardrailDecision, GuardrailPolicy, ToolResult } from '../../src/core/index.js';
import type { RbacSubject, ToolActor } from '../../src/core/index.js';

const subject: RbacSubject = { id: 'u1', roles: ['agent'] };
const actor: ToolActor = { key: 'k1', label: 'a1', onBehalfOf: 'alice' };
const ctx: GuardrailContext = {
  actor,
  subject,
  action: 'mcp.tool.reassign_ticket',
  args: { amount: 1000 },
  dataAccess: {} as never,
};

const policy = (name: string, decision: GuardrailDecision): GuardrailPolicy => ({ name, decide: () => decision });

describe('evaluatePolicies — decision matrix + fail-closed', () => {
  it('empty policies → allow fast path', async () => {
    expect(await evaluatePolicies([], ctx)).toEqual({ allow: true });
  });

  it('all allow → allow', async () => {
    expect(await evaluatePolicies([policy('a', { allow: true }), policy('b', { allow: true })], ctx)).toEqual({ allow: true });
  });

  it('any deny short-circuits (rest not executed)', async () => {
    let ran = false;
    const p: GuardrailPolicy = {
      name: 'after',
      decide: () => {
        ran = true;
        return { allow: true };
      },
    };
    const result = await evaluatePolicies([policy('deny', { allow: false, reason: 'no' }), p], ctx);
    expect(result).toMatchObject({ allow: false, reason: 'no' });
    expect(ran).toBe(false);
  });

  it('mask decisions merged (later overrides)', async () => {
    const result = await evaluatePolicies(
      [policy('m1', { allow: true, mask: { email: '***' } }), policy('m2', { allow: true, mask: { phone: '***' } })],
      ctx,
    );
    expect(result).toMatchObject({ allow: true, mask: { email: '***', phone: '***' } });
  });

  it('fail-closed: policy throws → deny + mcp.policy.denied', async () => {
    const throwing: GuardrailPolicy = {
      name: 'boom',
      decide: () => {
        throw new Error('db down');
      },
    };
    const result = await evaluatePolicies([throwing], ctx);
    expect(result).toMatchObject({ allow: false, errorCode: 'mcp.policy.denied' });
  });

  it('requireApproval decision passed through', async () => {
    const result = await evaluatePolicies([policy('ap', { allow: false, requireApproval: true, approvalKey: 'ap-x' })], ctx);
    expect(result).toMatchObject({ allow: false, requireApproval: true, approvalKey: 'ap-x' });
  });
});

describe('evaluateCall — approval lifecycle', () => {
  const approvals = () => {
    const queue = new Map<string, { approvalKey: string; status: ApprovalStatus; action: string; args: Record<string, unknown> }>();
    return {
      query: async () => [...queue.values()],
      pending: async (action: string, args: Record<string, unknown>, a: { key: string }, key?: string) => {
        queue.set(key ?? 'k', { approvalKey: key ?? 'k', status: 'pending', action, args });
      },
      queue,
    };
  };

  it('unknown requireApproval → enqueued pending', async () => {
    const ap = approvals();
    const result = await evaluateCall([policy('ap', { allow: false, requireApproval: true, approvalKey: 'ap-x' })], ap, ctx);
    expect(result).toMatchObject({ kind: 'pending', approvalKey: 'ap-x' });
    expect(ap.queue.get('ap-x')).toMatchObject({ status: 'pending' });
  });

  it('already approved → allow (client retry allowed)', async () => {
    const ap = approvals();
    ap.queue.set('ap-x', { approvalKey: 'ap-x', status: 'approved', action: ctx.action, args: ctx.args });
    const result = await evaluateCall([policy('ap', { allow: false, requireApproval: true, approvalKey: 'ap-x' })], ap, ctx);
    expect(result).toMatchObject({ kind: 'allow' });
  });

  it('already rejected → deny', async () => {
    const ap = approvals();
    ap.queue.set('ap-x', { approvalKey: 'ap-x', status: 'rejected', action: ctx.action, args: ctx.args });
    const result = await evaluateCall([policy('ap', { allow: false, requireApproval: true, approvalKey: 'ap-x' })], ap, ctx);
    expect(result).toMatchObject({ kind: 'deny', errorCode: 'mcp.approval.notFound' });
  });

  it('deny decision → deny', async () => {
    const ap = approvals();
    const result = await evaluateCall([policy('deny', { allow: false, reason: 'no' })], ap, ctx);
    expect(result).toMatchObject({ kind: 'deny', reason: 'no' });
  });

  it('empty policies → allow', async () => {
    const result = await evaluateCall([], approvals(), ctx);
    expect(result).toMatchObject({ kind: 'allow' });
  });
});

describe('evaluateTransition — workflow transition guard', () => {
  const approvals = () => {
    const queue = new Map<string, { approvalKey: string; status: ApprovalStatus; action: string; args: Record<string, unknown> }>();
    return {
      query: async () => [...queue.values()],
      pending: async (action: string, args: Record<string, unknown>, a: { key: string }, key?: string) => {
        queue.set(key ?? 'k', { approvalKey: key ?? 'k', status: 'pending', action, args });
      },
      queue,
    };
  };

  it('no policies + no requiresApproval → allow (fast path)', async () => {
    expect(await evaluateTransition([], undefined, ctx, false)).toEqual({ kind: 'allow' });
  });

  it('requiresApproval without a queue → deny workflow.approval.unavailable (fail closed)', async () => {
    const result = await evaluateTransition([], undefined, ctx, true);
    expect(result).toMatchObject({ kind: 'deny', code: 'workflow.approval.unavailable' });
  });

  it('requiresApproval with a queue → pending, then approved → allow', async () => {
    const ap = approvals();
    const first = await evaluateTransition([], ap, ctx, true);
    expect(first.kind).toBe('pending');
    const entry = [...ap.queue.values()][0]!;
    entry.status = 'approved';
    const second = await evaluateTransition([], ap, ctx, true);
    expect(second).toMatchObject({ kind: 'allow' });
  });

  it('policy deny → deny (mcp.policy.denied)', async () => {
    const result = await evaluateTransition([policy('deny', { allow: false, reason: 'no' })], approvals(), ctx, false);
    expect(result).toMatchObject({ kind: 'deny', code: 'mcp.policy.denied', reason: 'no' });
  });

  it('policy requireApproval → pending', async () => {
    const ap = approvals();
    const result = await evaluateTransition(
      [policy('ap', { allow: false, requireApproval: true, approvalKey: 'ap-x' })],
      ap,
      ctx,
      false,
    );
    expect(result).toMatchObject({ kind: 'pending', approvalKey: 'ap-x' });
  });
});

describe('applyMask — result masking', () => {
  const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

  it('JSON top-level field replacement', () => {
    const r = applyMask(text(JSON.stringify({ email: 'a@x.com', name: 'Alice' })), { email: '***' });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ email: '***', name: 'Alice' });
  });

  it('non-JSON text returned as-is', () => {
    const r = applyMask(text('just text'), { email: '***' });
    expect(r.content[0]!.text).toBe('just text');
  });

  it('missed field → as-is', () => {
    const r = applyMask(text(JSON.stringify({ name: 'Alice' })), { email: '***' });
    expect(r.content[0]!.text).toContain('Alice');
  });
});
