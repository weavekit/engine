import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, EXECUTION_STAGES, encodeRecordKey, type Evidence, type EvidenceSink } from '../../src/core/index.js';
import { createDataAccess } from '../../src/runtime/data-access/index.js';
import type { GuardrailPolicy } from '../../src/core/index.js';
import { insertEvidence } from '../../src/subsystems/evidence/store.js';

const evidence: Evidence = {
  requestId: 'req-1',
  actor: { key: 'cred', label: 'agent', onBehalfOf: 'alice' },
  subjectId: 'u1',
  plan: { action: 'object.lead.create', objectName: 'lead', args: { id: 'x' } },
  stages: [{ stage: EXECUTION_STAGES.PLAN, outcome: 'ok', at: new Date('2026-01-01T00:00:00Z') }],
  isError: false,
  timestamp: new Date('2026-01-01T00:00:00Z'),
};

describe('evidence store', () => {
  it('insertEvidence maps 16 columns with JSON plan/stages', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [] }; } };
    await insertEvidence(db as never, evidence);
    expect(calls[0]!.sql).toContain('INSERT INTO weavekit_evidence');
    expect(calls[0]!.params).toHaveLength(16);
    expect(calls[0]!.params[0]).toBe('req-1');
    expect(calls[0]!.params[10]).toBe(JSON.stringify(evidence.plan));
    expect(calls[0]!.params[11]).toBe(JSON.stringify(evidence.stages));
  });
});

describe('data-access evidence emission on a denylist gate', () => {
  const registry = new ObjectRegistry();
  registry.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }] });
  const principal = { kind: 'system' as const, capability: 'internal.admin' as const };
  const denyAll: GuardrailPolicy = { name: 'deny', decide: () => ({ allow: false, reason: 'blocked' }) };

  it('records evidence (plan + guardrail deny) when the gate denies', async () => {
    const events: Evidence[] = [];
    const sink: EvidenceSink = { record: async (e) => { events.push(e); } };
    const da = createDataAccess({ policies: [denyAll], evidence: sink });
    await da.create('lead', { id: 'x' }, { pool: { connect: () => { throw new Error('no'); } } as never, registry, principal }).catch(() => undefined);
    expect(events).toHaveLength(1);
    expect(events[0]!.plan.action).toBe('object.lead.create');
    expect(events[0]!.isError).toBe(true);
    expect(events[0]!.errorCode).toBe('mcp.policy.denied');
    expect(events[0]!.stages.some((s) => s.stage === EXECUTION_STAGES.GUARDRAIL && s.outcome === 'deny')).toBe(true);
  });

  it('records the instance schemaRevision + a per-context requestId', async () => {
    const events: Evidence[] = [];
    const sink: EvidenceSink = { record: async (e) => { events.push(e); } };
    const da = createDataAccess({ policies: [denyAll], evidence: sink, schemaRevision: 'rev-1' });
    await da
      .create('lead', { id: 'x' }, { pool: { connect: () => { throw new Error('no'); } } as never, registry, principal, requestId: 'req-9' })
      .catch(() => undefined);
    expect(events[0]!.schemaRevision).toBe('rev-1');
    expect(events[0]!.requestId).toBe('req-9');
  });
});

describe('data-access evidence covers every write (no policy gate required)', () => {
  const registry = new ObjectRegistry();
  registry.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }] });
  const principal = { kind: 'system' as const, capability: 'internal.admin' as const };
  const stagesOf = (e: Evidence) => e.stages.map((s) => `${s.stage}:${s.outcome}`);

  it('a failing write records one error evidence with execute stage and the original error', async () => {
    const events: Evidence[] = [];
    const da = createDataAccess({ evidence: { record: async (e) => { events.push(e); } } });
    const boom = new Error('connect refused');
    const caught = await da
      .create('lead', { id: 'x' }, { pool: { connect: () => { throw boom; } } as never, registry, principal })
      .catch((e: unknown) => e);
    expect(caught).toBe(boom);
    expect(events).toHaveLength(1);
    expect(events[0]!.isError).toBe(true);
    expect(stagesOf(events[0]!)).toEqual(['plan:ok', 'execute:error', 'evidence:error']);
  });

  it('a pending approval throws object.action.pending and records plan → guardrail → approval:pending', async () => {
    const events: Evidence[] = [];
    const needsApproval: GuardrailPolicy = { name: 'ask', decide: () => ({ allow: false, requireApproval: true, approvalKey: 'appr-1' }) };
    const approvals = {
      query: async () => [],
      pending: async () => {},
    };
    const da = createDataAccess({
      policies: [needsApproval],
      approvals: approvals as never,
      evidence: { record: async (e) => { events.push(e); } },
    });
    const caught = await da
      .delete('lead', encodeRecordKey(['x']), { pool: { connect: () => { throw new Error('unreachable'); } } as never, registry, principal })
      .catch((e: unknown) => e);
    expect((caught as { code?: string }).code).toBe('object.action.pending');
    expect(events).toHaveLength(1);
    expect(events[0]!.plan).toMatchObject({ action: 'object.lead.delete', objectName: 'lead', objectId: encodeRecordKey(['x']) });
    expect(stagesOf(events[0]!)).toContain('approval:pending');
    expect(stagesOf(events[0]!)).not.toContain('execute:ok');
  });

  it('without policies or evidence the write runs directly (no pipeline)', async () => {
    const da = createDataAccess();
    const boom = new Error('direct');
    const caught = await da
      .create('lead', { id: 'x' }, { pool: { connect: () => { throw boom; } } as never, registry, principal })
      .catch((e: unknown) => e);
    expect(caught).toBe(boom);
  });
});
