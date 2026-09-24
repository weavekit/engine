import { describe, it, expect } from '../helpers/test.js';
import {
  buildEngineFromRegistry,
  createPool,
  migrate,
  ObjectRegistry,
  type ObjectDefinition,
} from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const TIMED: ObjectDefinition = {
  name: 'wf_timed',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'status', type: 'enum', options: ['draft', 'expired', 'done'] },
  ],
  workflowEnabled: true,
  workflow: {
    initial: 'draft',
    stateField: 'status',
    states: [
      { name: 'draft', onTimeout: { after: '1h', action: 'expire' } },
      { name: 'expired' },
      { name: 'done' },
    ],
    transitions: [
      { action: 'expire', from: 'draft', to: 'expired' },
      { action: 'finish', from: 'expired', to: 'done' },
    ],
  },
  permissions: { admin: { read: 'all', create: true, update: true } },
};

maybe('Workflow timers E2E (local PG): schedule on entry, fire onTimeout, cancel on leave', () => {
  it('arms, claims and clears durable timers', async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(TIMED);
    registry0.buildGraph();

    const cleanupPool = createPool(url!);
    await cleanupPool.query('DROP TABLE IF EXISTS wf_timed, weavekit_workflow_timers, weavekit_meta CASCADE');
    await cleanupPool.end();

    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: { source: { 'key-admin': { id: 'admin1', roles: ['admin'] } } },
      subsystems: { workflow: { enabled: true, pollMs: 3_600_000 } },
    });
    const { pool, registry, dataAccess } = engine;
    const base = { pool, registry };
    try {
      await migrate(registry, { databaseUrl: url! });

      // entering a state with onTimeout arms a timer
      await dataAccess.create('wf_timed', { id: 'T1' }, base);
      const armed = await pool.query(
        `SELECT state FROM weavekit_workflow_timers WHERE object = 'wf_timed' AND id = 'T1'`,
      );
      expect(armed.rows).toHaveLength(1);
      expect(armed.rows[0].state).toBe('draft');

      // not due → nothing claimed
      expect(await engine.workflow!.runOnce()).toBe(0);

      // force due → the scheduler fires the declared auto-transition
      await pool.query(
        `UPDATE weavekit_workflow_timers SET due_at = now() - interval '1 minute' WHERE object = 'wf_timed' AND id = 'T1'`,
      );
      expect(await engine.workflow!.runOnce()).toBe(1);
      const after = await dataAccess.findOne<{ status: string }>('wf_timed', 'T1', base);
      expect(after?.status).toBe('expired');
      // the target state has no onTimeout → the timer is cleared
      const cleared = await pool.query(
        `SELECT 1 FROM weavekit_workflow_timers WHERE object = 'wf_timed' AND id = 'T1'`,
      );
      expect(cleared.rows).toHaveLength(0);

      // leaving a timed state via a normal transition cancels the timer
      await dataAccess.create('wf_timed', { id: 'T2' }, base);
      await dataAccess.transition('wf_timed', 'T2', 'expire', base);
      const t2 = await pool.query(
        `SELECT 1 FROM weavekit_workflow_timers WHERE object = 'wf_timed' AND id = 'T2'`,
      );
      expect(t2.rows).toHaveLength(0);

      // delete cancels the timer
      await dataAccess.create('wf_timed', { id: 'T3' }, base);
      await dataAccess.delete('wf_timed', 'T3', base);
      const t3 = await pool.query(
        `SELECT 1 FROM weavekit_workflow_timers WHERE object = 'wf_timed' AND id = 'T3'`,
      );
      expect(t3.rows).toHaveLength(0);
    } finally {
      await engine.close();
    }
  }, 120000);
});
