import { describe, it, before, after, expect } from '../helpers/test.js';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const DOC: ObjectDefinition = {
  name: 'wf_spec',
  fields: [{ name: 'id', type: 'string', primary: true }],
  workflowEnabled: true,
  workflow: { nodes: [{ id: 'review', assign: { roles: ['approver'] } }] },
  permissions: {
    admin: { read: 'all', create: true, update: true },
    approver: { read: 'all', update: true },
  },
};

const admin = { id: '77777777-7777-7777-7777-777777777777', roles: ['admin'] };
const approver = { id: '66666666-6666-6666-6666-666666666666', roles: ['approver'] };

maybe('Workflow spec write-back E2E (admin GET/PUT objects/<name>/workflow.json)', () => {
  let pool: Pool;
  let engine: WeaveKitEngine;
  let projectDir: string;

  before(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'weavekit-wf-spec-'));
    spawnSync('git', ['init'], { cwd: projectDir });
    await mkdir(join(projectDir, 'objects', 'wf_spec'), { recursive: true });
    await writeFile(
      join(projectDir, 'objects', 'wf_spec', 'workflow.json'),
      `${JSON.stringify({ schemaVersion: 2, nodes: [{ id: 'review', assign: { roles: ['approver'] } }] }, null, 2)}\n`,
    );

    pool = createPool(url!);
    await pool.query(`DROP TABLE IF EXISTS wf_spec, weavekit_record__wf_spec CASCADE`);
    const registry = new ObjectRegistry();
    registry.register(DOC);
    registry.buildGraph();
    await migrate(registry, { databaseUrl: url! });
    await pool.query(
      `DELETE FROM weavekit_workflow_workitems WHERE object = 'wf_spec';
       DELETE FROM weavekit_workflow_steps WHERE object = 'wf_spec';
       DELETE FROM weavekit_workflow_instances WHERE object = 'wf_spec';`,
    );
    engine = await buildEngineFromRegistry(registry, {
      databaseUrl: url!,
      schemaDir: projectDir,
      adapters: { rest: { adminRoles: ['admin'] } },
      auth: {
        source: {
          'key-admin': { id: admin.id, roles: ['admin'] },
          'key-approver': { id: approver.id, roles: ['approver'] },
        },
      },
    });
  });

  after(async () => {
    await engine?.close();
    await pool?.end();
    await rm(projectDir, { recursive: true, force: true });
  });

  const specUrl = '/api/objects/wf_spec/workflow/spec';

  it('GET returns the raw workflow.json source + version (admin only)', async () => {
    const denied = await engine.app.inject({ method: 'GET', url: specUrl, headers: { authorization: 'Bearer key-approver' } });
    expect(denied.statusCode).toBe(403);

    const res = await engine.app.inject({ method: 'GET', url: specUrl, headers: { authorization: 'Bearer key-admin' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { source: string; version: string };
    expect(body.source).toContain('"review"');
    expect(body.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PUT writes and commits a new definition (optimistic lock)', async () => {
    const current = (
      await engine.app.inject({ method: 'GET', url: specUrl, headers: { authorization: 'Bearer key-admin' } })
    ).json() as { version: string };

    const put = await engine.app.inject({
      method: 'PUT',
      url: specUrl,
      headers: { authorization: 'Bearer key-admin' },
      payload: {
        expectVersion: current.version,
        nodes: [
          { id: 'review', assign: { roles: ['approver'] } },
          { id: 'sign', assign: { roles: ['manager'] } },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const result = put.json() as { ok: boolean; committed: boolean; hash: string };
    expect(result.ok).toBe(true);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);

    // a second PUT against the now-stale version is a 409 conflict
    const stale = await engine.app.inject({
      method: 'PUT',
      url: specUrl,
      headers: { authorization: 'Bearer key-admin' },
      payload: { expectVersion: current.version, nodes: [{ id: 'review', assign: { roles: ['approver'] } }] },
    });
    expect(stale.statusCode).toBe(409);
  });
});
