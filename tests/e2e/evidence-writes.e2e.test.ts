import { describe, it, before, after, expect } from '../helpers/test.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import { buildEngineFromRegistry, createPool, migrate, ObjectRegistry, type ObjectDefinition, type WeaveKitEngine } from '../../src/index.js';
import { queryEvidence } from '../../src/subsystems/evidence/index.js';
import type { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const ITEM: ObjectDefinition = {
  name: 'ev_item',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
  ],
  workflowEnabled: true,
  workflow: { nodes: [{ id: 'review', assign: { roles: ['editor'] } }] },
  permissions: { editor: { read: 'all', create: true, update: true, delete: true } },
};

const editor = { id: '71111111-1111-1111-1111-111111111111', roles: ['editor'] };

maybe('Evidence E2E: every governed write records one evidence row with its real outcome', () => {
  let pool: Pool;
  let engine: WeaveKitEngine;

  before(async () => {
    pool = createPool(url!);
    await pool.query(`DROP TABLE IF EXISTS ev_item, weavekit_record__ev_item CASCADE`);
    const registry = new ObjectRegistry();
    registry.register(ITEM);
    registry.buildGraph();
    await migrate(registry, { databaseUrl: url! });
    await pool.query(`DELETE FROM weavekit_evidence WHERE object = 'ev_item'`);
    await pool.query(`DELETE FROM weavekit_workflow_instances WHERE object = 'ev_item'`);
    await pool.query(`DELETE FROM weavekit_user WHERE id::text = $1`, [editor.id]);
    await pool.query(`INSERT INTO weavekit_user (id, roles, enabled) VALUES ($1, $2::jsonb, true)`, [editor.id, JSON.stringify(editor.roles)]);
    engine = await buildEngineFromRegistry(registry, {
      databaseUrl: url!,
      auth: { source: { 'key-editor': editor } },
      evidence: { enabled: true },
    });
  });

  after(async () => {
    await engine?.close();
    await pool?.end();
  });

  const dctx = { get pool() { return engine.pool; }, get registry() { return engine.registry; }, principal: { kind: 'user' as const, subject: editor } };
  const stagesOf = (stages: { stage: string; outcome: string }[]) => stages.map((s) => `${s.stage}:${s.outcome}`);

  it('records ok / error outcomes after execution for create, update, delete and transition', async () => {
    await engine.dataAccess.create('ev_item', { id: 'E1', title: 'a' }, dctx);
    await engine.dataAccess.create('ev_item', { id: 'E1', title: 'dup' }, dctx).catch(() => undefined);
    const id = encodeRecordKey(['E1']);
    await engine.dataAccess.update('ev_item', id, { title: 'b' }, dctx);
    await engine.dataAccess.transition('ev_item', id, 'submit', dctx);
    await engine.dataAccess.create('ev_item', { id: 'E2' }, dctx);
    await engine.dataAccess.delete('ev_item', encodeRecordKey(['E2']), dctx);

    const { rows } = await queryEvidence(pool, { objectName: 'ev_item', limit: 50 });
    const byAction = rows.slice().reverse().map((e) => ({ action: e.plan.action, isError: e.isError, errorCode: e.errorCode, stages: stagesOf(e.stages) }));
    expect(byAction.map((e) => e.action)).toEqual([
      'object.ev_item.create',
      'object.ev_item.create',
      'object.ev_item.update',
      'workflow.transition.ev_item.submit',
      'object.ev_item.create',
      'object.ev_item.delete',
    ]);
    expect(byAction[0]).toMatchObject({ isError: false });
    expect(byAction[0]!.stages).toEqual(['plan:ok', 'execute:ok', 'commit:ok', 'evidence:ok']);
    expect(byAction[1]).toMatchObject({ isError: true, errorCode: 'data.unique' });
    expect(byAction[1]!.stages).toContain('execute:error');
    expect(rows.every((e) => e.subjectId === editor.id)).toBe(true);
  });
});
