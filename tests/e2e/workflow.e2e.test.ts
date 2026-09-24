import { describe, it, expect } from '../helpers/test.js';
import {
  buildEngineFromRegistry,
  createDataAccess,
  migrate,
  ObjectRegistry,
  SchemaError,
  type GuardrailPolicy,
  type ObjectDefinition,
} from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const TICKET: ObjectDefinition = {
  name: 'wf_ticket',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
    { name: 'status', type: 'enum', options: ['draft', 'open', 'closed'] },
  ],
  workflow: {
    initial: 'draft',
    stateField: 'status',
    states: [{ name: 'draft' }, { name: 'open' }, { name: 'closed' }],
    transitions: [
      { action: 'open', from: 'draft', to: 'open', roles: ['agent'] },
      { action: 'close', from: 'open', to: 'closed' },
    ],
  },
  permissions: {
    agent: { read: 'all', create: true, update: ['title'], delete: true },
    operator: { read: 'all', update: true },
    admin: { read: 'all', create: true, update: true, delete: true },
    viewer: { read: 'all' },
  },
};

maybe('Workflow E2E (local PG): transitions, RBAC and state-field immutability', () => {
  it('enforces transitions end to end', async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(TICKET);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: {
        source: {
          'key-agent': { id: 'u1', roles: ['agent'] },
          'key-operator': { id: 'u2', roles: ['operator'] },
          'key-admin': { id: 'u3', roles: ['admin'] },
          'key-viewer': { id: 'u4', roles: ['viewer'] },
        },
      },
    });
    const { app, pool, registry, dataAccess } = engine;
    const base = { pool, registry };
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

    try {
      await pool.query('DROP TABLE IF EXISTS wf_ticket, weavekit_meta CASCADE');
      await migrate(registry, { databaseUrl: url! });
      await dataAccess.create('wf_ticket', { id: 'T1', title: 'first' }, base);

      const get = (key: string) =>
        app.inject({ method: 'GET', url: '/api/objects/wf_ticket/T1/workflow', headers: bearer(key) });
      const post = (action: string, key: string) =>
        app.inject({
          method: 'POST',
          url: `/api/objects/wf_ticket/T1/transitions/${action}`,
          headers: bearer(key),
        });
      const patch = (body: unknown, key: string) =>
        app.inject({
          method: 'PATCH',
          url: '/api/objects/wf_ticket/T1',
          headers: bearer(key),
          payload: body as never,
        });

      // new record starts in the declared initial state
      const created = await dataAccess.findOne<Record<string, unknown>>('wf_ticket', 'T1', base);
      expect(created?.status).toBe('draft');

      // GET: current state + only the transitions allowed from it
      const meta = await get('key-agent');
      expect(meta.statusCode).toBe(200);
      expect(meta.json()).toMatchObject({ state: 'draft', initial: 'draft' });
      expect(meta.json().actions.map((a: { action: string }) => a.action)).toEqual(['open']);

      // POST as a role without update permission → 403
      const viewer = await post('open', 'key-viewer');
      expect(viewer.statusCode).toBe(403);

      // POST a transition whose role gate excludes the caller → 403 workflow.transition.denied
      const operator = await post('open', 'key-operator');
      expect(operator.statusCode).toBe(403);
      expect(operator.json().error.code).toBe('workflow.transition.denied');

      // POST an unknown action → 404
      const unknown = await post('bogus', 'key-agent');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('workflow.transition.unknown');

      // POST a known action that is invalid from the current state → 409
      const notAllowed = await post('close', 'key-agent');
      expect(notAllowed.statusCode).toBe(409);
      expect(notAllowed.json().error.code).toBe('workflow.transition.notAllowed');

      // direct write to the state field is rejected → 400
      const direct = await patch({ status: 'closed' }, 'key-admin');
      expect(direct.statusCode).toBe(400);
      expect(direct.json().error.code).toBe('workflow.transition.required');

      // happy path: open, then close
      const opened = await post('open', 'key-agent');
      expect(opened.statusCode).toBe(200);
      expect(opened.json().status).toBe('open');

      const afterOpen = await get('key-agent');
      expect(afterOpen.json().actions.map((a: { action: string }) => a.action)).toEqual(['close']);

      const closed = await post('close', 'key-agent');
      expect(closed.statusCode).toBe(200);
      expect(closed.json().status).toBe('closed');

      // terminal state: no available actions
      const terminal = await get('key-agent');
      expect(terminal.json().actions).toEqual([]);

      // create cannot seed a state other than `initial`
      const createBypass = await dataAccess
        .create('wf_ticket', { id: 'T2', title: 'second', status: 'closed' }, base)
        .then(() => undefined)
        .catch((error: unknown) => (error instanceof SchemaError ? error.code : 'other'));
      expect(createBypass).toBe('workflow.transition.required');

      // a script beforeUpdate hook cannot move the state field either
      await dataAccess.create('wf_ticket', { id: 'T3', title: 'third' }, base);
      const guarded = createDataAccess({
        script: {
          has: (_object, hook) => hook === 'beforeUpdate',
          dispatch: async () => ({ changes: { status: 'closed' }, warnings: [] }),
          close: async () => {},
        },
      });
      const hookBypass = await guarded
        .update('wf_ticket', 'T3', { title: 'changed' }, base)
        .then(() => undefined)
        .catch((error: unknown) => (error instanceof SchemaError ? error.code : 'other'));
      expect(hookBypass).toBe('workflow.transition.required');
    } finally {
      await engine.close();
    }
  }, 120000);

  it('guardrail policy + approval gate: pending → approve → retry, policy deny', async () => {
    const GATED: ObjectDefinition = {
      name: 'wf_gated',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'status', type: 'enum', options: ['draft', 'pending', 'approved', 'rejected'] },
      ],
      workflow: {
        initial: 'draft',
        stateField: 'status',
        states: [{ name: 'draft' }, { name: 'pending' }, { name: 'approved' }, { name: 'rejected' }],
        transitions: [
          { action: 'submit', from: 'draft', to: 'pending', requiresApproval: true },
          { action: 'approve', from: 'pending', to: 'approved' },
          { action: 'reject', from: 'pending', to: 'rejected' },
        ],
      },
      permissions: { admin: { read: 'all', create: true, update: true } },
    };
    const denyReject: GuardrailPolicy = {
      name: 'deny-reject',
      decide: (c) =>
        c.action.endsWith('.reject')
          ? { allow: false, reason: 'reject is not allowed here' }
          : { allow: true },
    };
    const registry0 = new ObjectRegistry();
    registry0.register(GATED);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: { source: { 'key-admin': { id: 'admin1', roles: ['admin'] } } },
      tools: { guardrails: { policies: [denyReject] }, approvals: { backend: 'memory' } },
    });
    const { app, pool, registry, dataAccess } = engine;
    try {
      await pool.query('DROP TABLE IF EXISTS wf_gated, weavekit_meta CASCADE');
      await migrate(registry, { databaseUrl: url! });
      await dataAccess.create('wf_gated', { id: 'G1' }, { pool, registry });
      const post = (action: string) =>
        app.inject({
          method: 'POST',
          url: `/api/objects/wf_gated/G1/transitions/${action}`,
          headers: { authorization: 'Bearer key-admin' },
        });

      // requiresApproval → 409 pending with the deterministic key
      const pending = await post('submit');
      expect(pending.statusCode).toBe(409);
      expect(pending.json().error.code).toBe('workflow.transition.pending');
      const key = pending.json().error.params.approvalKey as string;
      expect(typeof key).toBe('string');

      // not yet approved → still pending
      expect((await post('submit')).statusCode).toBe(409);

      // approve the key → retry succeeds
      expect(engine.approvals).toBeDefined();
      await engine.approvals!.approve(key, 'admin1');
      const submitted = await post('submit');
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json().status).toBe('pending');

      // policy denies the reject transition → 400 mcp.policy.denied
      const denied = await post('reject');
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.code).toBe('mcp.policy.denied');

      // policy allows approve
      const approved = await post('approve');
      expect(approved.statusCode).toBe(200);
      expect(approved.json().status).toBe('approved');
    } finally {
      await engine.close();
    }
  }, 120000);

  it('fails closed when a transition requires approval but no queue is configured', async () => {
    const GATED: ObjectDefinition = {
      name: 'wf_gated',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'status', type: 'enum', options: ['draft', 'pending'] },
      ],
      workflow: {
        initial: 'draft',
        stateField: 'status',
        states: [{ name: 'draft' }, { name: 'pending' }],
        transitions: [{ action: 'submit', from: 'draft', to: 'pending', requiresApproval: true }],
      },
      permissions: { admin: { read: 'all', create: true, update: true } },
    };
    const registry0 = new ObjectRegistry();
    registry0.register(GATED);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: { source: { 'key-admin': { id: 'admin1', roles: ['admin'] } } },
    });
    const { app, pool, registry, dataAccess } = engine;
    try {
      await pool.query('DROP TABLE IF EXISTS wf_gated, weavekit_meta CASCADE');
      await migrate(registry, { databaseUrl: url! });
      await dataAccess.create('wf_gated', { id: 'G2' }, { pool, registry });
      const res = await app.inject({
        method: 'POST',
        url: '/api/objects/wf_gated/G2/transitions/submit',
        headers: { authorization: 'Bearer key-admin' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('workflow.approval.unavailable');
    } finally {
      await engine.close();
    }
  }, 120000);
});
