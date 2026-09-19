import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from '../helpers/test.js';import { createPool, migrate, ObjectRegistry, FIELD_TYPES, SchemaError } from '../../src/index.js';
import { createDataAccess } from '../../src/runtime/data-access/index.js';
import { createScriptDispatcher } from '../../src/subsystems/script/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Script subsystem E2E (local PG)', () => {
  it('write hooks: beforeUpdate rewrite / validate abort / afterUpdate warning / db.objects RPC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-script-e2e-'));
    const objectsDir = join(root, 'objects');
    await mkdir(join(objectsDir, 'scr_lead'), { recursive: true });
    await writeFile(
      join(objectsDir, 'scr_lead', 'server.js'),
      `export function beforeUpdate() {
  if (this.changes.title) this.changes.title = String(this.changes.title).toUpperCase();
  return this.changes;
}
export function validate() {
  if (this.record === null && this.changes.status === 'rejected') throw new Error('cannot create rejected');
  if (this.record !== null && this.record.status === 'closed') throw new Error('closed records cannot be updated');
}
export async function afterUpdate() {
  throw new Error('notification failed');
}
export function beforeDelete() {
  if (this.record.status === 'approved') throw new Error('approved records cannot be deleted');
}
`,
    );

    const registry = new ObjectRegistry();
    registry.register({
      name: 'scr_lead',
      fields: [
        { name: 'id', type: FIELD_TYPES.STRING, primary: true },
        { name: 'title', type: FIELD_TYPES.STRING, required: true },
        { name: 'status', type: FIELD_TYPES.ENUM, options: ['open', 'closed', 'rejected', 'approved'], default: 'open' },
      ],
    });
    registry.register({
      name: 'scr_log',
      fields: [
        { name: 'id', type: FIELD_TYPES.STRING, primary: true },
        { name: 'message', type: FIELD_TYPES.STRING },
      ],
    });

    const pool = createPool(url!, { query_timeout: 5000, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
    const { createAudit, createBufferedAuditSink } = await import('../../src/subsystems/audit/index.js');
    let auditSink: ReturnType<typeof createBufferedAuditSink>;
    try {
      await pool.query('DROP TABLE IF EXISTS "scr_lead", "scr_log", weavekit_seq, weavekit_meta CASCADE');
      await migrate(registry, { databaseUrl: url });
      const audit = await createAudit(pool);
      auditSink = createBufferedAuditSink(audit);

      const rawDataAccess = createDataAccess({ audit: auditSink });
      const dispatcher = await createScriptDispatcher({
        objectsDir,
        registry,
        pool,
        dataAccess: rawDataAccess,
        config: { sandbox: { timeout: 3000, queryTimeout: 1000 } },
      });
      const dataAccess = createDataAccess({ audit: auditSink, script: dispatcher });
      const ctx = { pool, registry };

      // 1. beforeUpdate rewrites payload
      await dataAccess.create('scr_lead', { id: 'L1', title: 'hello', status: 'open' }, ctx);
      expect((await dataAccess.findOne('scr_lead', 'L1', ctx))?.title).toBe('HELLO');

      // 2. validate aborts create → no record
      try {
        await dataAccess.create('scr_lead', { id: 'L2', title: 'nope', status: 'rejected' }, ctx);
        throw new Error('expected validate abort');
      } catch (e) {
        expect(e).toBeInstanceOf(SchemaError);
        expect((e as SchemaError).message).toContain('cannot create rejected');
      }
      expect(await dataAccess.findOne('scr_lead', 'L2', ctx)).toBeNull();

      // 3. validate aborts update (closed not modifiable) → status unchanged
      await dataAccess.create('scr_lead', { id: 'L3', title: 'keep', status: 'open' }, ctx);
      await dataAccess.update('scr_lead', 'L3', { status: 'closed' }, ctx);
      try {
        await dataAccess.update('scr_lead', 'L3', { title: 'X' }, ctx);
        throw new Error('expected validate abort on closed');
      } catch (e) {
        expect((e as SchemaError).message).toContain('closed records cannot be updated');
      }
      expect((await dataAccess.findOne('scr_lead', 'L3', ctx))?.title).toBe('KEEP');
      expect((await dataAccess.findOne('scr_lead', 'L3', ctx))?.status).toBe('closed');

      // 4. afterUpdate throws → write committed + warnings callback + audit isError
      const warnings: string[] = [];
      const updateCtx = { pool, registry, onWarnings: (ws: string[]) => warnings.push(...ws) };
      await dataAccess.update('scr_lead', 'L1', { status: 'approved' }, updateCtx);
      expect((await dataAccess.findOne('scr_lead', 'L1', ctx))?.status).toBe('approved');
      expect(warnings).toEqual(['notification failed']);
      await auditSink.flush();
      const events = await audit.query({ object: 'scr_lead' });
      expect(events.rows.some((r) => r.isError && r.errorCode === 'script.abort' && r.action === 'update')).toBe(true);

      // 5. beforeDelete aborts approved → record remains
      try {
        await dataAccess.delete('scr_lead', 'L1', ctx);
        throw new Error('expected beforeDelete abort');
      } catch (e) {
        expect((e as SchemaError).message).toContain('approved records cannot be deleted');
      }
      expect(await dataAccess.findOne('scr_lead', 'L1', ctx)).not.toBeNull();

      // 6. normal delete
      await dataAccess.update('scr_lead', 'L1', { status: 'open' }, ctx);
      await dataAccess.delete('scr_lead', 'L1', ctx);
      expect(await dataAccess.findOne('scr_lead', 'L1', ctx)).toBeNull();

      await dispatcher.close();
      await auditSink.flush();
    } finally {
      await pool.query('DROP TABLE IF EXISTS "scr_lead", "scr_log", weavekit_seq, weavekit_meta CASCADE');
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it('this.db.objects RPC inside hook really persists + this.db.query restricted SQL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-script-rpc-e2e-'));
    const objectsDir = join(root, 'objects');
    await mkdir(join(objectsDir, 'scr_order'), { recursive: true });
    await writeFile(
      join(objectsDir, 'scr_order', 'server.js'),
      `export async function afterUpdate() {
  const created = await this.db.objects('scr_log').create({
    id: 'a-' + this.record.id,
    message: 'order ' + this.record.id + ' touched',
  });
  const rows = await this.db.query('SELECT COUNT(*)::int AS n FROM scr_log', []);
  return this.changes;
}
`,
    );

    const registry = new ObjectRegistry();
    registry.register({ name: 'scr_order', fields: [{ name: 'id', type: FIELD_TYPES.STRING, primary: true }, { name: 'amount', type: FIELD_TYPES.NUMBER }] });
    registry.register({ name: 'scr_log', fields: [{ name: 'id', type: FIELD_TYPES.STRING, primary: true }, { name: 'message', type: FIELD_TYPES.STRING }] });

    const pool = createPool(url!, { query_timeout: 5000, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
    try {
      await pool.query('DROP TABLE IF EXISTS "scr_order", "scr_log", weavekit_seq, weavekit_meta CASCADE');
      // rls: with the script subsystem enabled, db.query runs as the
      // weavekit_query role, so migrate must provision it + GRANT SELECT
      await migrate(registry, { databaseUrl: url, rls: { role: 'weavekit_query' } });

      const dataAccess = createDataAccess();
      const dispatcher = await createScriptDispatcher({
        objectsDir,
        registry,
        pool,
        dataAccess,
        config: { sandbox: { timeout: 3000, queryTimeout: 1000 } },
      });
      const scripted = createDataAccess({ script: dispatcher });
      const warnings: string[] = [];
      const ctx = { pool, registry, onWarnings: (ws: string[]) => warnings.push(...ws) };

      await scripted.create('scr_order', { id: 'O1', amount: 100 }, ctx);
      const logs = await dataAccess.find('scr_log', {}, ctx);
      expect(warnings).toEqual([]);
      expect(logs.rows).toHaveLength(1);
      expect(logs.rows[0]).toMatchObject({ id: 'a-O1', message: 'order O1 touched' });

      await dispatcher.close();
    } finally {
      await pool.query('DROP TABLE IF EXISTS "scr_order", "scr_log", weavekit_seq, weavekit_meta CASCADE');
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
