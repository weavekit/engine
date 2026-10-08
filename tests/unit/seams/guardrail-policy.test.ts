import { describe, it, expect } from '../../helpers/test.js';
import { evaluatePolicies, type GuardrailContext, type GuardrailPolicy } from '../../../src/core/index.js';

/**
 * `GuardrailPolicy` seam contract: declaration-order evaluation, first
 * deny/requireApproval short-circuits, mask merges (later wins), and
 * **fail-closed** on a throwing policy. An enterprise/E5 policy must honour
 * these semantics.
 */

const ctx: GuardrailContext = {
  actor: { key: 'agent-1', label: 'agent', onBehalfOf: 'u1' },
  subject: { id: 'u1', roles: ['sales'] },
  action: 'mcp.tool.delete_record',
  args: { id: 'X' },
  dataAccess: {} as never,
};

const allow = (name: string, mask?: Record<string, string>): GuardrailPolicy => ({
  name,
  decide: () => (mask === undefined ? { allow: true } : { allow: true, mask }),
});

describe('GuardrailPolicy seam contract', () => {
  it('no policies → allow (fast path)', async () => {
    expect(await evaluatePolicies([], ctx)).toEqual({ allow: true });
  });

  it('deny short-circuits later policies', async () => {
    let later = false;
    const policies: GuardrailPolicy[] = [
      { name: 'deny', decide: () => ({ allow: false, reason: 'nope', errorCode: 'x.denied' }) },
      { name: 'later', decide: () => { later = true; return { allow: true }; } },
    ];
    const d = await evaluatePolicies(policies, ctx);
    expect(d).toEqual({ allow: false, reason: 'nope', errorCode: 'x.denied' });
    expect(later).toBe(false);
  });

  it('requireApproval short-circuits and carries the approval key', async () => {
    const d = await evaluatePolicies(
      [{ name: 'appr', decide: () => ({ allow: false, requireApproval: true, approvalKey: 'ap-z' }) }],
      ctx,
    );
    expect(d).toEqual({ allow: false, requireApproval: true, approvalKey: 'ap-z' });
  });

  it('mask decisions merge; later wins', async () => {
    const d = await evaluatePolicies(
      [allow('a', { ssn: 'redact', email: 'redact' }), allow('b', { email: 'hash' })],
      ctx,
    );
    expect(d).toEqual({ allow: true, mask: { ssn: 'redact', email: 'hash' } });
  });

  it('fail-closed: a throwing policy denies with mcp.policy.denied', async () => {
    const d = await evaluatePolicies(
      [
        { name: 'boom', decide: () => { throw new Error('backend down'); } },
        allow('later'),
      ],
      ctx,
    );
    expect(d.allow).toBe(false);
    if (d.allow === false && 'errorCode' in d) expect(d.errorCode).toBe('mcp.policy.denied');
  });

  it('supports async decide()', async () => {
    const d = await evaluatePolicies([{ name: 'async', decide: async () => ({ allow: true }) }], ctx);
    expect(d).toEqual({ allow: true });
  });
});
