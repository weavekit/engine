import { randomUUID } from 'node:crypto';
import { describe, it, before, after, expect } from '../helpers/test.js';
import {
  buildEngineFromRegistry,
  createPool,
  encodeRecordKey,
  migrate,
  ObjectRegistry,
  SchemaError,
  SYSTEM_CAPABILITIES,
  systemPrincipal,
  type IdentitySubject,
  type ObjectDefinition,
  type WeaveKitEngine,
} from '../../src/index.js';
import { createDataAccess } from '../../src/runtime/data-access/index.js';
import { asRlsRole } from '../../src/runtime/data-access/rls-session.js';
import type { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;
const ROLE = 'weavekit_object';

const DOC: ObjectDefinition = {
  name: 'rl_doc',
  alter: true,
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'owner_id', type: 'string', ownership: true },
    { name: 'dept_id', type: 'string', department: true },
    { name: 'org', type: 'string', scope: true },
    { name: 'title', type: 'string' },
    { name: 'tags', type: 'multiRelation', target: 'rl_tag' },
  ],
  permissions: {
    writer: { read: 'own', update: true, delete: true },
    lead: { read: 'department' },
    editor: { read: 'all', manage: 'own', update: true, delete: true },
  },
};
const TAG: ObjectDefinition = { name: 'rl_tag', alter: true, fields: [{ name: 'id', type: 'string', primary: true }] };
const NOTE: ObjectDefinition = {
  name: 'rl_note',
  alter: true,
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'owner_ref', type: 'string', ownership: true, ownershipSource: 'external' },
  ],
  permissions: { writer: { read: 'own' } },
};
const HEAD: ObjectDefinition = {
  name: 'rl_head',
  alter: true,
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'owner_id', type: 'string', ownership: true },
    { name: 'lines', type: 'details', target: 'rl_line' },
  ],
  permissions: { writer: { read: 'own', create: true, update: true } },
};
const LINE: ObjectDefinition = { name: 'rl_line', alter: true, fields: [{ name: 'id', type: 'string', primary: true }, { name: 'qty', type: 'integer' }] };

const TABLES = 'rl_doc, rl_tag, rl_note, rl_head, rl_line';

maybe('Object-path RLS E2E (rls.enforce): parity with the app layer + database backstop', () => {
  let pool: Pool;
  let registry: ObjectRegistry;
  let enforced: WeaveKitEngine;
  let appOnly: WeaveKitEngine;
  const root = randomUUID();
  const child = randomUUID();
  const other = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();

  const subjects: Record<string, IdentitySubject> = {
    writerAlice: { id: alice, roles: ['writer'] },
    writerBob: { id: bob, roles: ['writer'] },
    leadRoot: { id: randomUUID(), roles: ['lead'], departmentId: root },
    leadChild: { id: randomUUID(), roles: ['lead'], departmentId: child },
    editorAlice: { id: alice, roles: ['editor'] },
    editorScopedA: { id: alice, roles: ['editor'], scopeId: 'A' },
  };

  before(async () => {
    pool = createPool(url!);
    await pool.query(`DROP TABLE IF EXISTS ${TABLES}, weavekit_m2m__rl_doc__tags CASCADE`);
    await pool.query(`DELETE FROM weavekit_user WHERE id = ANY($1::uuid[])`, [[alice, bob]]);
    registry = new ObjectRegistry();
    for (const def of [DOC, TAG, NOTE, HEAD, LINE]) registry.register(def);
    registry.buildGraph();
    const result = await migrate(registry, { databaseUrl: url!, objectRls: { role: ROLE } });
    expect(result.warnings.filter((w) => w.includes('object RLS'))).toEqual([]);

    await pool.query(
      `INSERT INTO weavekit_department (id, name, parent_id) VALUES ($1, 'Root', NULL), ($2, 'Child', $1), ($3, 'Other', NULL)`,
      [root, child, other],
    );
    await pool.query(
      `INSERT INTO weavekit_user (id, external_source, external_id, name, department_id, roles, enabled)
       VALUES ($1, 'crm', 'ext-alice', 'Alice', $2, '["writer"]'::jsonb, true), ($3, 'crm', 'ext-bob', 'Bob', $4, '["writer"]'::jsonb, true)`,
      [alice, root, bob, other],
    );

    const sys = { pool, registry, principal: systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN) };
    const seed = createDataAccess();
    for (const t of ['t1', 't2']) await seed.create('rl_tag', { id: t }, sys);
    await seed.create('rl_doc', { id: 'd1', owner_id: alice, dept_id: root, org: 'A', title: 'a', tags: ['t1'] }, sys);
    await seed.create('rl_doc', { id: 'd2', owner_id: bob, dept_id: other, org: 'A', title: 'b' }, sys);
    await seed.create('rl_doc', { id: 'd3', owner_id: bob, dept_id: child, org: 'B', title: 'c', tags: ['t2'] }, sys);
    await seed.create('rl_doc', { id: 'd4', owner_id: alice, dept_id: child, org: 'B', title: 'd' }, sys);
    await seed.create('rl_note', { id: 'n-a', owner_ref: 'ext-alice' }, sys);
    await seed.create('rl_note', { id: 'n-b', owner_ref: 'ext-bob' }, sys);
    await seed.create('rl_head', { id: 'h1', owner_id: alice, lines: [{ id: 'l1', qty: 1 }] }, sys);
    await seed.create('rl_head', { id: 'h2', owner_id: bob, lines: [{ id: 'l2', qty: 2 }] }, sys);

    const auth = { source: { 'k-alice': subjects.writerAlice! } };
    enforced = await buildEngineFromRegistry(registry, { databaseUrl: url!, auth, rls: { enforce: true } });
    appOnly = await buildEngineFromRegistry(registry, { databaseUrl: url!, auth });
  });

  after(async () => {
    await enforced?.close();
    await appOnly?.close();
    await pool?.query(`DROP TABLE IF EXISTS ${TABLES}, weavekit_m2m__rl_doc__tags CASCADE`);
    await pool?.query(`DELETE FROM weavekit_user WHERE id = ANY($1::uuid[])`, [[alice, bob]]);
    await pool?.query(`DELETE FROM weavekit_department WHERE id = ANY($1::uuid[])`, [[root, child, other]]);
    await pool?.end();
  });

  const ctx = (engine: WeaveKitEngine, subject: IdentitySubject) => ({
    pool: engine.pool,
    registry: engine.registry,
    principal: { kind: 'user' as const, subject },
  });
  const sorted = (rows: unknown[]) => (rows as Array<Record<string, unknown>>).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));

  /** rows the policies alone allow (no application filter at all) */
  async function rlsOnly(table: string, subject: IdentitySubject): Promise<string[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await asRlsRole(client, ROLE, subject, () => client.query(`SELECT id FROM ${table} ORDER BY id`));
      await client.query('COMMIT');
      return rows.map((r: { id: string }) => r.id);
    } finally {
      client.release();
    }
  }

  it('enforced reads equal app-only reads, and the policies alone select the same rows', async () => {
    const cases: Array<[string, string]> = [
      ['rl_doc', 'writerAlice'],
      ['rl_doc', 'writerBob'],
      ['rl_doc', 'leadRoot'],
      ['rl_doc', 'leadChild'],
      ['rl_doc', 'editorAlice'],
      ['rl_doc', 'editorScopedA'],
      ['rl_note', 'writerAlice'],
      ['rl_head', 'writerAlice'],
      ['rl_line', 'writerAlice'],
      ['rl_line', 'writerBob'],
    ];
    for (const [table, who] of cases) {
      const subject = subjects[who]!;
      const withRls = await enforced.dataAccess.find(table, {}, ctx(enforced, subject));
      const plain = await appOnly.dataAccess.find(table, {}, ctx(appOnly, subject));
      expect({ table, who, rows: sorted(withRls.rows), total: withRls.total }).toEqual({ table, who, rows: sorted(plain.rows), total: plain.total });
      const ids = sorted(plain.rows).map((r) => r.id);
      expect({ table, who, ids: await rlsOnly(table, subject) }).toEqual({ table, who, ids });
    }
  });

  it('the database blocks rows a missing application filter would leak (backstop)', async () => {
    // inner data access without the RBAC decorator: no row scope is injected
    const bare = createDataAccess({ rls: { role: ROLE } });
    const asWriter = ctx(enforced, subjects.writerAlice!);
    const leaked = await bare.find('rl_doc', {}, asWriter);
    expect(sorted(leaked.rows).map((r) => r.id)).toEqual(['d1', 'd4']);

    let caught: unknown;
    try {
      await bare.update('rl_doc', encodeRecordKey(['d2']), { title: 'x' }, asWriter);
    } catch (error) {
      caught = error;
    }
    expect((caught as SchemaError).code).toBe('data.recordNotFound');
    caught = undefined;
    try {
      await bare.delete('rl_doc', encodeRecordKey(['d2']), asWriter);
    } catch (error) {
      caught = error;
    }
    expect((caught as SchemaError).code).toBe('data.recordNotFound');
    const d2 = await pool.query(`SELECT title FROM rl_doc WHERE id = 'd2'`);
    expect(d2.rows[0]).toEqual({ title: 'b' });
  });

  it('writes in scope still succeed under the role (update, delete, create stays with the owner)', async () => {
    const editor = ctx(enforced, subjects.editorAlice!);
    const updated = await enforced.dataAccess.update<{ title: string }>('rl_doc', encodeRecordKey(['d4']), { title: 'mine' }, editor);
    expect(updated.title).toBe('mine');
    const writer = ctx(enforced, subjects.writerAlice!);
    await enforced.dataAccess.create('rl_head', { id: 'h3', owner_id: alice, lines: [{ id: 'l3', qty: 3 }] }, writer);
    await enforced.dataAccess.delete('rl_doc', encodeRecordKey(['d4']), editor);
    expect((await pool.query(`SELECT 1 FROM rl_doc WHERE id = 'd4'`)).rowCount).toBe(0);
  });

  it('refuses to start when enforcement is on but a table lacks its policies', async () => {
    await pool.query(`DROP POLICY IF EXISTS weavekit_obj_select ON rl_note`);
    let caught: unknown;
    try {
      const engine = await buildEngineFromRegistry(registry, { databaseUrl: url!, auth: { source: {} }, rls: { enforce: true } });
      await engine.close();
    } catch (error) {
      caught = error;
    }
    expect((caught as SchemaError).code).toBe('engine.rls.notProvisioned');
    expect(String((caught as SchemaError).params.detail)).toContain('rl_note');
    const again = await migrate(registry, { databaseUrl: url!, objectRls: { role: ROLE } });
    expect(again.statements.some((s) => s.includes('CREATE POLICY weavekit_obj_select ON "rl_note"'))).toBe(true);
    const idempotent = await migrate(registry, { databaseUrl: url!, objectRls: { role: ROLE } });
    expect(idempotent.statements.filter((s) => s.includes('weavekit_obj_') || s.startsWith('GRANT'))).toEqual([]);
  });
});
