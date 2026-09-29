import { describe, it, before, after, expect } from '../helpers/test.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import {
  buildEngineFromRegistry,
  createPool,
  migrate,
  ObjectRegistry,
  SchemaError,
  type GuardrailPolicy,
  type ObjectDefinition,
  type WeaveKitEngine,
} from '../../src/index.js';
import type { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const DOC: ObjectDefinition = {
  name: 'wf_doc',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
  ],
  workflowEnabled: true,
  workflow: {
    nodes: [
      { id: 'review', assign: { roles: ['approver'], mode: 'any' } },
      { id: 'sign', assign: { roles: ['manager'], mode: 'all' } },
    ],
  },
  permissions: {
    admin: { read: 'all', create: true, update: true, delete: true },
    approver: { read: 'all', update: true },
    manager: { read: 'all', update: true },
  },
};

const GAP: ObjectDefinition = {
  name: 'wf_gap',
  fields: [{ name: 'id', type: 'string', primary: true }],
  workflowEnabled: true,
  workflow: { nodes: [{ id: 'review', assign: { roles: ['ghost'] } }] },
  permissions: { admin: { read: 'all', create: true, update: true } },
};

const GATED: ObjectDefinition = {
  name: 'wf_gated',
  fields: [{ name: 'id', type: 'string', primary: true }],
  workflowEnabled: true,
  workflow: { nodes: [{ id: 'review', assign: { roles: ['approver'] }, requiresApproval: true }] },
  permissions: {
    admin: { read: 'all', create: true, update: true },
    approver: { read: 'all', update: true },
  },
};

const DENIED: ObjectDefinition = {
  name: 'wf_denied',
  fields: [{ name: 'id', type: 'string', primary: true }],
  workflowEnabled: true,
  workflow: { nodes: [{ id: 'review', assign: { roles: ['approver'] } }] },
  permissions: {
    admin: { read: 'all', create: true, update: true },
    approver: { read: 'all', update: true },
  },
};

const denyWfDenied: GuardrailPolicy = {
  name: 'deny-wf-denied',
  decide: async (c) =>
    c.action === 'workflow.transition.wf_denied.approve' ? { allow: false, reason: 'blocked' } : { allow: true },
};

const admin = { id: '11111111-1111-1111-1111-111111111111', roles: ['admin'] };
const a1 = { id: '22222222-2222-2222-2222-222222222222', roles: ['approver'] };
const a2 = { id: '33333333-3333-3333-3333-333333333333', roles: ['approver'] };
const m1 = { id: '44444444-4444-4444-4444-444444444444', roles: ['manager'] };
const m2 = { id: '55555555-5555-5555-5555-555555555555', roles: ['manager'] };

maybe('Workflow runtime E2E (three-layer: instance/step/workitem, local PG)', () => {
  let pool: Pool;
  let engine: WeaveKitEngine;
  let registry: ObjectRegistry;

  before(async () => {
    pool = createPool(url!);
    await pool.query(
      `DROP TABLE IF EXISTS wf_doc, wf_gap, wf_gated, wf_denied,
         weavekit_record__wf_doc, weavekit_record__wf_gap, weavekit_record__wf_gated, weavekit_record__wf_denied CASCADE`,
    );
    await pool.query(
      `DELETE FROM weavekit_workflow_workitems; DELETE FROM weavekit_workflow_steps;
       DELETE FROM weavekit_workflow_locks; DELETE FROM weavekit_workflow_instances;
       DELETE FROM weavekit_workflow_definitions;`,
    );
    await pool.query(`DELETE FROM weavekit_user`);
    registry = new ObjectRegistry();
    registry.register(DOC);
    registry.register(GAP);
    registry.register(GATED);
    registry.register(DENIED);
    registry.buildGraph();
    await migrate(registry, { databaseUrl: url! });
    // seed identity: two approvers, two managers
    for (const [id, role] of [
      [admin.id, 'admin'],
      [a1.id, 'approver'],
      [a2.id, 'approver'],
      [m1.id, 'manager'],
      [m2.id, 'manager'],
    ] as const) {
      await pool.query(`INSERT INTO weavekit_user (id, roles, enabled) VALUES ($1, $2::jsonb, true)`, [
        id,
        JSON.stringify([role]),
      ]);
    }
    engine = await buildEngineFromRegistry(registry, {
      databaseUrl: url!,
      auth: {
        source: {
          'key-admin': { id: admin.id, roles: ['admin'] },
          'key-a1': { id: a1.id, roles: ['approver'] },
          'key-a2': { id: a2.id, roles: ['approver'] },
          'key-m1': { id: m1.id, roles: ['manager'] },
          'key-m2': { id: m2.id, roles: ['manager'] },
        },
      },
      tools: { guardrails: { policies: [denyWfDenied] } },
    });
  });

  after(async () => {
    await engine?.close();
    await pool?.end();
  });

  const dctx = (subject: { id: string; roles: string[] }) => ({
    pool: engine.pool,
    registry: engine.registry,
    subject,
  });

  const submit = (id: string, s = admin) => engine.dataAccess.transition('wf_doc', id, 'submit', dctx(s));
  const act = (id: string, action: string, s: { id: string; roles: string[] }, payload?: Record<string, unknown>) =>
    engine.dataAccess.transition('wf_doc', id, action, dctx(s), payload);

  async function instanceOf(id: string) {
    const r = await pool.query(
      `SELECT i.state, i.approval, s.node_id AS node
         FROM weavekit_workflow_instances i
         LEFT JOIN weavekit_workflow_steps s ON s.id = i.current_step_id
        WHERE i.object = 'wf_doc' AND i.record_key = $1`,
      [id],
    );
    return r.rows[0] as { state: string; approval: string | null; node: string | null } | undefined;
  }

  async function sideStatus(id: string) {
    const r = await pool.query(`SELECT status FROM weavekit_record__wf_doc WHERE record_key = $1`, [id]);
    return (r.rows[0] as { status: string } | undefined)?.status;
  }

  it('runs submit → any-quorum review → all-quorum signature → effective', async () => {
    const id = encodeRecordKey(['D1']);
    await engine.dataAccess.create('wf_doc', { id: 'D1', title: 't' }, dctx(admin));
    expect(await sideStatus(id)).toBe('draft');

    await submit(id);
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: 'review' });
    expect(await sideStatus(id)).toBe('running');

    // any-quorum: the first approver advances
    await act(id, 'approve', a1);
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: 'sign' });

    // all-quorum: one manager is not enough
    await act(id, 'approve', m1);
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: 'sign' });
    await act(id, 'approve', m2);
    expect(await instanceOf(id)).toMatchObject({ state: 'finished', approval: 'approved' });
    expect(await sideStatus(id)).toBe('effective');
  });

  it('rejects back to the start node (record: reject cannot return to draft)', async () => {
    const id = encodeRecordKey(['D2']);
    await engine.dataAccess.create('wf_doc', { id: 'D2' }, dctx(admin));
    await submit(id);
    await act(id, 'approve', a1);
    await act(id, 'reject', m1, { comment: 'no' });
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: '__start__' });
    expect(await sideStatus(id)).toBe('running');
    // the originator edits in place and resubmits
    await submit(id);
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: 'review' });
  });

  it('withdraws (originator) back to start, and is blocked while another user holds a lock', async () => {
    const id = encodeRecordKey(['D3']);
    await engine.dataAccess.create('wf_doc', { id: 'D3' }, dctx(admin));
    await submit(id);

    // simulate a2 viewing: lock a2's workitem
    const wi = await pool.query(
      `SELECT w.id FROM weavekit_workflow_workitems w
         JOIN weavekit_workflow_instances i ON i.current_step_id = w.step_id
        WHERE i.record_key = $1 AND w.participant = $2`,
      [id, a2.id],
    );
    await pool.query(
      `INSERT INTO weavekit_workflow_locks (workitem_id, object, record_key, holder, expires_at)
       VALUES ($1, 'wf_doc', $2, $3, now() + interval '60 seconds')`,
      [wi.rows[0].id, id, a2.id],
    );
    await expect(act(id, 'withdraw', admin)).rejects.toMatchObject({ code: 'workflow.withdraw.locked' });
    await pool.query(`DELETE FROM weavekit_workflow_locks WHERE record_key = $1`, [id]);
    await act(id, 'withdraw', admin);
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: '__start__' });
  });

  it('cancels to a terminal state', async () => {
    const id = encodeRecordKey(['D4']);
    await engine.dataAccess.create('wf_doc', { id: 'D4' }, dctx(admin));
    await submit(id);
    await act(id, 'cancel', admin);
    expect(await instanceOf(id)).toMatchObject({ state: 'canceled' });
    expect(await sideStatus(id)).toBe('canceled');
  });

  it('forwards a workitem to another user (transferred + receiptor)', async () => {
    const id = encodeRecordKey(['D5']);
    await engine.dataAccess.create('wf_doc', { id: 'D5' }, dctx(admin));
    await submit(id);
    await act(id, 'forward', a1, { to: { userId: a2.id } });
    const r = await pool.query(
      `SELECT state, receiptor, delegant FROM weavekit_workflow_workitems
        WHERE record_key = $1 AND participant = $2 ORDER BY received_at`,
      [id, a1.id],
    );
    expect(r.rows[0]).toMatchObject({ state: 'transferred', receiptor: a2.id, delegant: a1.id });
    const target = await pool.query(
      `SELECT state FROM weavekit_workflow_workitems WHERE record_key = $1 AND participant = $2 AND state = 'active'`,
      [id, a2.id],
    );
    expect(target.rows).toHaveLength(1);
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: 'review' });
  });

  it('fails closed when a node resolves to no assignees', async () => {
    const id = encodeRecordKey(['G1']);
    await engine.dataAccess.create('wf_gap', { id: 'G1' }, dctx(admin));
    let caught: unknown;
    try {
      await engine.dataAccess.transition('wf_gap', id, 'submit', {
        pool: engine.pool,
        registry: engine.registry,
        subject: admin,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    expect((caught as SchemaError).code).toBe('workflow.assignee.none');
  });

  it('denies a non-participant approving', async () => {
    const id = encodeRecordKey(['D6']);
    await engine.dataAccess.create('wf_doc', { id: 'D6' }, dctx(admin));
    await submit(id);
    // m1 is a valid role holder but not a workitem participant at the review node
    await expect(act(id, 'approve', m1)).rejects.toMatchObject({ code: 'workflow.transition.denied' });
  });

  it('exposes workflow status / actions / lock over REST', async () => {
    const id = encodeRecordKey(['D7']);
    await engine.dataAccess.create('wf_doc', { id: 'D7' }, dctx(admin));

    const draft = await engine.app.inject({
      method: 'GET',
      url: `/api/objects/wf_doc/${id}/workflow`,
      headers: { authorization: 'Bearer key-admin' },
    });
    expect(draft.statusCode).toBe(200);
    expect((draft.json() as { state: string }).state).toBe('draft');
    expect((draft.json() as { actions: string[] }).actions).toContain('submit');

    const submitted = await engine.app.inject({
      method: 'POST',
      url: `/api/objects/wf_doc/${id}/workflow/submit`,
      headers: { authorization: 'Bearer key-admin' },
    });
    expect(submitted.statusCode).toBe(200);

    const status = await engine.app.inject({
      method: 'GET',
      url: `/api/objects/wf_doc/${id}/workflow`,
      headers: { authorization: 'Bearer key-a1' },
    });
    const body = status.json() as { state: string; node: string; actions: string[] };
    expect(body.state).toBe('running');
    expect(body.node).toBe('review');
    expect(body.actions).toEqual(['approve', 'reject', 'forward', 'withdraw']);

    const lock = await engine.app.inject({
      method: 'POST',
      url: `/api/objects/wf_doc/${id}/workflow/lock`,
      headers: { authorization: 'Bearer key-a1' },
    });
    expect(lock.statusCode).toBe(200);
    expect((lock.json() as { expiresAt: string }).expiresAt).toBeDefined();

    const unlock = await engine.app.inject({
      method: 'DELETE',
      url: `/api/objects/wf_doc/${id}/workflow/lock`,
      headers: { authorization: 'Bearer key-a1' },
    });
    expect(unlock.statusCode).toBe(200);
  });

  it('reactivates a terminal instance to a node (admin only; pinned version unchanged)', async () => {
    const id = encodeRecordKey(['D8']);
    await engine.dataAccess.create('wf_doc', { id: 'D8' }, dctx(admin));
    await submit(id);
    await act(id, 'approve', a1);
    await act(id, 'approve', m1);
    await act(id, 'approve', m2);
    expect(await instanceOf(id)).toMatchObject({ state: 'finished' });

    const hashOf = async () =>
      (await pool.query(`SELECT workflow_hash FROM weavekit_workflow_instances WHERE record_key = $1`, [id])).rows[0]
        .workflow_hash as string;
    const before = await hashOf();

    await expect(act(id, 'reactivate', a1, { node: 'review' })).rejects.toMatchObject({
      code: 'workflow.transition.denied',
    });
    await expect(act(id, 'reactivate', admin, { node: 'ghost' })).rejects.toMatchObject({
      code: 'workflow.node.unknown',
    });

    await act(id, 'reactivate', admin, { node: 'review' });
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: 'review' });
    expect(await hashOf()).toBe(before);
  });

  it('returns step/workitem history over REST', async () => {
    const id = encodeRecordKey(['D9']);
    await engine.dataAccess.create('wf_doc', { id: 'D9' }, dctx(admin));
    await submit(id);
    await act(id, 'approve', a1);
    const res = await engine.app.inject({
      method: 'GET',
      url: `/api/objects/wf_doc/${id}/workflow/history`,
      headers: { authorization: 'Bearer key-admin' },
    });
    expect(res.statusCode).toBe(200);
    const h = res.json() as { state: string; steps: unknown[]; workitems: unknown[] };
    expect(h.state).toBe('running');
    expect(h.steps).toHaveLength(2);
    expect(h.workitems.length).toBeGreaterThanOrEqual(2);
  });

  it('lists the caller pending workitems (todos)', async () => {
    const id = encodeRecordKey(['D10']);
    await engine.dataAccess.create('wf_doc', { id: 'D10' }, dctx(admin));
    await submit(id);
    const res = await engine.app.inject({
      method: 'GET',
      url: '/api/workflow/todos',
      headers: { authorization: 'Bearer key-a1' },
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: Array<{ recordKey: string; nodeId: string }> }).items;
    expect(items.some((t) => t.recordKey === id && t.nodeId === 'review')).toBe(true);
  });

  it('admin PATCH override: jump to a node and terminate', async () => {
    const id = encodeRecordKey(['D11']);
    await engine.dataAccess.create('wf_doc', { id: 'D11' }, dctx(admin));
    await submit(id);
    await expect(
      engine.dataAccess.overrideWorkflow('wf_doc', id, { node: 'sign' }, dctx(a1)),
    ).rejects.toMatchObject({ code: 'workflow.transition.denied' });
    await engine.dataAccess.overrideWorkflow('wf_doc', id, { node: 'sign' }, dctx(admin));
    expect(await instanceOf(id)).toMatchObject({ state: 'running', node: 'sign' });
    await expect(
      engine.dataAccess.overrideWorkflow('wf_doc', id, { node: 'ghost' }, dctx(admin)),
    ).rejects.toMatchObject({ code: 'workflow.node.unknown' });
    await engine.dataAccess.overrideWorkflow('wf_doc', id, { state: 'canceled' }, dctx(admin));
    expect(await instanceOf(id)).toMatchObject({ state: 'canceled' });
  });

  it('resolves a node-level requiresApproval through the approval queue (pending)', async () => {
    const id = encodeRecordKey(['G2']);
    await engine.dataAccess.create('wf_gated', { id: 'G2' }, dctx(admin));
    await engine.dataAccess.transition('wf_gated', id, 'submit', dctx(admin));
    await expect(
      engine.dataAccess.transition('wf_gated', id, 'approve', dctx(a1)),
    ).rejects.toMatchObject({ code: 'workflow.transition.pending' });
  });

  it('applies guardrail policies to transitions (deny)', async () => {
    const id = encodeRecordKey(['X1']);
    await engine.dataAccess.create('wf_denied', { id: 'X1' }, dctx(admin));
    await engine.dataAccess.transition('wf_denied', id, 'submit', dctx(admin));
    await expect(
      engine.dataAccess.transition('wf_denied', id, 'approve', dctx(a1)),
    ).rejects.toMatchObject({ code: 'mcp.policy.denied' });
  });

  it('registers each object definition content-addressably on migrate', async () => {
    const r = await pool.query(
      `SELECT hash FROM weavekit_workflow_definitions WHERE object = 'wf_doc'`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
    expect(String((r.rows[0] as { hash: string }).hash)).toMatch(/^[0-9a-f]{64}$/);
  });
});
