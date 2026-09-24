import { describe, it, expect } from '../helpers/test.js';
import {
  buildEngineFromRegistry,
  createDataAccess,
  migrate,
  ObjectRegistry,
  SchemaError,
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
});
