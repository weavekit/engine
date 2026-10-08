import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, SchemaError } from '../../src/core/index.js';
import type { GuardrailPolicy } from '../../src/core/index.js';
import { createDataAccess } from '../../src/runtime/data-access/index.js';
import type { PolicyApprovals } from '../../src/runtime/tools/policies.js';

const principal = { kind: 'system' as const, capability: 'internal.admin' as const };
const registry = new ObjectRegistry();
registry.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }] });

const denyAll: GuardrailPolicy = {
  name: 'deny-all',
  decide: () => ({ allow: false, reason: 'blocked' }),
};

function mustNotConnectPool() {
  return { connect: () => { throw new Error('pool.connect must not be called when denied'); } };
}

describe('data-access guardrail gate (object.<obj>.<op>)', () => {
  it('default (no policies) → guard is skipped (pool is used normally)', async () => {
    const da = createDataAccess();
    let connected = 0;
    const pool = {
      connect: () => {
        connected += 1;
        throw new Error('connect reached (proves guard skipped)');
      },
    };
    await da.create('lead', { id: 'x' }, { pool: pool as never, registry, principal }).catch(() => undefined);
    expect(connected).toBe(1);
  });

  it('deny policy blocks create before any DB work', async () => {
    const da = createDataAccess({ policies: [denyAll] });
    let caught: unknown;
    try {
      await da.create('lead', { id: 'x' }, { pool: mustNotConnectPool() as never, registry, principal });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    expect((caught as SchemaError).code).toBe('mcp.policy.denied');
  });

  it('deny policy blocks update and delete too', async () => {
    const da = createDataAccess({ policies: [denyAll] });
    for (const op of [
      () => da.update('lead', 'x', { id: 'y' }, { pool: mustNotConnectPool() as never, registry, principal }),
      () => da.delete('lead', 'x', { pool: mustNotConnectPool() as never, registry, principal }),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(SchemaError);
    }
  });

  it('requiresApproval → object.action.pending with the approval key', async () => {
    const approvals: PolicyApprovals = {
      query: async () => [],
      pending: async () => {},
    };
    const requireApproval: GuardrailPolicy = {
      name: 'approve',
      decide: () => ({ allow: false, requireApproval: true, approvalKey: 'ap-1' }),
    };
    const da = createDataAccess({ policies: [requireApproval], approvals });
    let caught: unknown;
    try {
      await da.create('lead', { id: 'x' }, { pool: mustNotConnectPool() as never, registry, principal });
    } catch (error) {
      caught = error;
    }
    expect((caught as SchemaError).code).toBe('object.action.pending');
    expect((caught as SchemaError).params.approvalKey).toBe('ap-1');
  });
});
