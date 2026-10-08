import { describe, it, before, after, expect } from '../helpers/test.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import {
  buildEngineFromRegistry,
  createPool,
  migrate,
  ObjectRegistry,
  type ObjectDefinition,
  type WeaveKitEngine,
} from '../../src/index.js';
import type { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const TIMED: ObjectDefinition = {
  name: 'wf_timed',
  fields: [{ name: 'id', type: 'string', primary: true }],
  workflowEnabled: true,
  workflow: {
    nodes: [
      { id: 'hold', assign: { roles: ['holder'] }, onTimeout: { after: '1h', action: 'approve' } },
      { id: 'done', assign: { roles: ['holder'] } },
    ],
  },
  permissions: {
    admin: { read: 'all', create: true, update: true },
    holder: { read: 'all', update: true },
  },
};

const admin = { id: '99999999-9999-9999-9999-999999999999', roles: ['admin'] };
const holder = { id: '88888888-8888-8888-8888-888888888888', roles: ['holder'] };

maybe('Workflow timers E2E (three-layer): arm on node entry, fire onTimeout, cancel on leave', () => {
  let pool: Pool;
  let engine: WeaveKitEngine;
  let registry: ObjectRegistry;

  before(async () => {
    pool = createPool(url!);
    await pool.query(`DROP TABLE IF EXISTS wf_timed, weavekit_record__wf_timed CASCADE`);
    await pool.query(
      `DELETE FROM weavekit_workflow_workitems WHERE object = 'wf_timed';
       DELETE FROM weavekit_workflow_steps WHERE object = 'wf_timed';
       DELETE FROM weavekit_workflow_timers WHERE object = 'wf_timed';
       DELETE FROM weavekit_workflow_instances WHERE object = 'wf_timed';`,
    );
    await pool.query(`DELETE FROM weavekit_user WHERE id = $1`, [holder.id]);
    registry = new ObjectRegistry();
    registry.register(TIMED);
    registry.buildGraph();
    await migrate(registry, { databaseUrl: url! });
    await pool.query(`INSERT INTO weavekit_user (id, roles, enabled) VALUES ($1, $2::jsonb, true)`, [
      holder.id,
      JSON.stringify(['holder']),
    ]);
    engine = await buildEngineFromRegistry(registry, {
      databaseUrl: url!,
      auth: {
        source: {
          'key-admin': { id: admin.id, roles: ['admin'] },
          'key-holder': { id: holder.id, roles: ['holder'] },
        },
      },
      subsystems: { workflow: { enabled: true, pollMs: 3_600_000 } },
    });
  });

  after(async () => {
    await engine?.close();
    await pool?.end();
  });

  it('arms a timer on entry and fires the onTimeout action when due', async () => {
    const id = encodeRecordKey(['T1']);
    const ctx = { pool: engine.pool, registry: engine.registry, principal: { kind: 'user' as const, subject: admin } };
    await engine.dataAccess.create('wf_timed', { id: 'T1' }, ctx);
    await engine.dataAccess.transition('wf_timed', id, 'submit', ctx);

    const armed = await pool.query(`SELECT node_id FROM weavekit_workflow_timers WHERE object = 'wf_timed' AND record_key = $1`, [id]);
    expect(armed.rows[0]).toMatchObject({ node_id: 'hold' });

    // fire as if 2h passed
    const fired = await engine.workflow!.runOnce(new Date(Date.now() + 2 * 3_600_000));
    expect(fired).toBe(1);

    const inst = await pool.query(
      `SELECT i.state, s.node_id AS node FROM weavekit_workflow_instances i
         JOIN weavekit_workflow_steps s ON s.id = i.current_step_id
        WHERE i.object = 'wf_timed' AND i.record_key = $1`,
      [id],
    );
    expect(inst.rows[0]).toMatchObject({ state: 'running', node: 'done' });

    // the 'done' node has no timeout -> the timer is gone
    const left = await pool.query(`SELECT 1 FROM weavekit_workflow_timers WHERE object = 'wf_timed' AND record_key = $1`, [id]);
    expect(left.rows).toHaveLength(0);
  });
});
