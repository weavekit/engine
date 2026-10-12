import { describe, it, before, after, expect } from '../helpers/test.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import {
  buildEngineFromRegistry,
  createPool,
  migrate,
  ObjectRegistry,
  SchemaError,
  type ObjectDefinition,
  type WeaveKitEngine,
} from '../../src/index.js';
import type { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const OWN: ObjectDefinition = {
  name: 'wf_own',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'owner_id', type: 'string', ownership: true },
  ],
  workflowEnabled: true,
  workflow: { nodes: [{ id: 'review', assign: { roles: ['approver'], mode: 'any' } }] },
  permissions: {
    author: { read: 'own', create: true, update: true },
    approver: { read: 'own', update: true },
  },
};

const alice = { id: '61111111-1111-1111-1111-111111111111', roles: ['author'] };
const bob = { id: '62222222-2222-2222-2222-222222222222', roles: ['author'] };
const appr = { id: '63333333-3333-3333-3333-333333333333', roles: ['approver'] };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof SchemaError) return error.code;
    throw error;
  }
  return 'ok';
}

maybe('Workflow row scope E2E: submit / status / history honor the caller row scope', () => {
  let pool: Pool;
  let engine: WeaveKitEngine;

  before(async () => {
    pool = createPool(url!);
    await pool.query(`DROP TABLE IF EXISTS wf_own, weavekit_record__wf_own CASCADE`);
    await pool.query(`DELETE FROM weavekit_workflow_workitems WHERE object = 'wf_own'`).catch(() => {});
    await pool.query(`DELETE FROM weavekit_workflow_steps WHERE object = 'wf_own'`).catch(() => {});
    await pool.query(`DELETE FROM weavekit_workflow_instances WHERE object = 'wf_own'`).catch(() => {});
    const registry = new ObjectRegistry();
    registry.register(OWN);
    registry.buildGraph();
    await migrate(registry, { databaseUrl: url! });
    await pool.query(`DELETE FROM weavekit_user WHERE id::text = ANY($1::text[])`, [[alice.id, bob.id, appr.id]]);
    for (const s of [alice, bob, appr]) {
      await pool.query(`INSERT INTO weavekit_user (id, roles, enabled) VALUES ($1, $2::jsonb, true)`, [s.id, JSON.stringify(s.roles)]);
    }
    engine = await buildEngineFromRegistry(registry, { databaseUrl: url!, auth: { source: { 'key-alice': alice } } });
  });

  after(async () => {
    await engine?.close();
    await pool?.end();
  });

  const dctx = (subject: { id: string; roles: string[] }) => ({
    pool: engine.pool,
    registry: engine.registry,
    principal: { kind: 'user' as const, subject },
  });

  it('another author cannot submit, or read the workflow of, a record outside their scope', async () => {
    const id = encodeRecordKey(['S1']);
    await engine.dataAccess.create('wf_own', { id: 'S1', owner_id: alice.id }, dctx(alice));

    expect(await codeOf(engine.dataAccess.transition('wf_own', id, 'submit', dctx(bob)))).toBe('data.recordNotFound');
    const inst = await pool.query(`SELECT 1 FROM weavekit_workflow_instances WHERE object = 'wf_own' AND record_key = $1`, [id]);
    expect(inst.rowCount).toBe(0);
    expect(await codeOf(engine.dataAccess.workflowStatus('wf_own', id, dctx(bob)))).toBe('data.recordNotFound');
    expect(await codeOf(engine.dataAccess.workflowHistory('wf_own', id, dctx(bob)))).toBe('data.recordNotFound');
  });

  it('the owner submits; an assigned approver outside the row scope still sees and approves it', async () => {
    const id = encodeRecordKey(['S2']);
    await engine.dataAccess.create('wf_own', { id: 'S2', owner_id: alice.id }, dctx(alice));
    await engine.dataAccess.transition('wf_own', id, 'submit', dctx(alice));

    const status = await engine.dataAccess.workflowStatus('wf_own', id, dctx(appr));
    expect(status.actions).toContain('approve');
    await engine.dataAccess.transition('wf_own', id, 'approve', dctx(appr));
    const after = await engine.dataAccess.workflowStatus('wf_own', id, dctx(alice));
    expect(after.state).toBe('finished');
    expect(await codeOf(engine.dataAccess.workflowStatus('wf_own', id, dctx(bob)))).toBe('data.recordNotFound');
  });
});
