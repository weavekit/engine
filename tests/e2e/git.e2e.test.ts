import { describe, it, expect } from '../helpers/test.js';import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoCommit, createEngine, createPool, syncSchema } from '../../src/index.js';
import { readMetadataCache } from '../../src/experimental.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD = JSON.stringify({
  name: 'lead',
  label: 'Lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
  ],
});

const LEAD_V2 = JSON.stringify({
  name: 'lead',
  label: 'Lead',
  alter: true,
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
    { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
  ],
});

/** same schema as LEAD_V2 but WITHOUT `alter` — existing-table change must be rejected */
const LEAD_DRIFT = JSON.stringify({
  name: 'lead',
  label: 'Lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
    { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
  ],
});

const CUSTOMER = JSON.stringify({
  name: 'customer',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
  ],
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stdout} ${error.message}`));
      else resolve(stdout);
    });
  });
}

async function initRepo(root: string): Promise<void> {
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
}

async function writeObject(root: string, name: string, json: string): Promise<void> {
  await mkdir(join(root, 'objects', name), { recursive: true });
  await writeFile(join(root, 'objects', name, 'schema.json'), json);
}

maybe('Git-backed metadata E2E (local PG + temporary git repo)', () => {
  it('syncSchema: load→create tables→cache write; rerun idempotent; file change triggers DDL; deleted object clears cache; autoCommit; createEngine wiring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weavekit-e2e-'));
    const pool = createPool(url!);
    try {
      await initRepo(root);
      await writeObject(root, 'lead', LEAD);
      await writeObject(root, 'customer', CUSTOMER);

      // 1. first sync: create tables + cache write
      const first = await syncSchema({ dir: root, databaseUrl: url! });
      expect(first.migration.applied.sort()).toEqual(['customer', 'lead']);
      expect(first.cache.updated.sort()).toEqual(['customer', 'lead']);

      const cache1 = await readMetadataCache(pool);
      expect(cache1.has('lead')).toBe(true);
      expect(cache1.has('customer')).toBe(true);
      const leadRow = await pool.query("SELECT content_hash FROM weavekit_metadata WHERE object_name = 'lead'");
      expect(leadRow.rows).toHaveLength(1);

      // 2. rerun: no DDL, no cache update (idempotent)
      const second = await syncSchema({ dir: root, databaseUrl: url! });
      expect(second.migration.statements).toHaveLength(0);
      expect(second.cache.updated).toHaveLength(0);
      expect(second.cache.removed).toHaveLength(0);

      // 3. modify lead adding a field: alter:false object → existing table read-only, syncSchema rejects (field.columnMissing)
      await writeObject(root, 'lead', LEAD_DRIFT);
      let thirdError: Error | undefined;
      try {
        await syncSchema({ dir: root, databaseUrl: url! });
      } catch (e) {
        thirdError = e as Error;
      }
      expect(thirdError).toBeDefined();
      expect(thirdError!.message).toContain('field "status" does not exist as a column in existing table "lead"');
      // restore lead, continue with later steps
      await writeObject(root, 'lead', LEAD);
      const third = await syncSchema({ dir: root, databaseUrl: url! });
      expect(third.migration.statements).toHaveLength(0);

      // 4. delete customer file: table kept, cache row removed
      await rm(join(root, 'objects', 'customer'), { recursive: true, force: true });
      const fourth = await syncSchema({ dir: root, databaseUrl: url! });
      expect(fourth.cache.removed).toEqual(['customer']);
      const cache2 = await readMetadataCache(pool);
      expect(cache2.has('customer')).toBe(false);
      expect(cache2.has('lead')).toBe(true);
      const tbl = await pool.query("SELECT to_regclass('customer') AS t");
      expect(tbl.rows[0].t).not.toBeNull();

      // 5. autoCommit: metadata committed, visible to git
      const commit = await autoCommit({ dir: root });
      expect(commit.committed).toBe(true);
      const log = await git(root, ['log', '--oneline', '--all']);
      expect(log).toContain('chore(metadata): sync schema objects');

      // 6. createEngine({ schemaDir, migrate: { auto: true } }): syncs on startup, REST available
      const engine = await createEngine({
        databaseUrl: url!,
        schemaDir: root,
        auth: { source: { 'k-admin': { id: 'u1', roles: ['admin'] } } },
        migrate: { auto: true },
      });
      try {
        expect(engine.registry.get('lead')?.fields).toHaveLength(2);
        const res = await engine.app.inject({
          method: 'GET',
          url: '/api/objects/lead',
          headers: { authorization: 'Bearer k-admin' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().total).toBe(0);
      } finally {
        await engine.close();
      }

      // 7. migrate.auto + schema.alter + commit.meta: startup migration honors per-object alter →
      // existing table auto ADD COLUMN; metadata tree auto git commit (HEAD advances); writes schema.changed audit
      await writeObject(root, 'lead', LEAD_V2);
      const headBefore = await git(root, ['rev-parse', 'HEAD']);
      const engine2 = await createEngine({
        databaseUrl: url!,
        schemaDir: root,
        auth: { source: { 'k-admin': { id: 'u1', roles: ['admin'] } } },
        migrate: { auto: true },
        commit: { meta: true, identity: { name: 'Bot', email: 'bot@local' } },
      });
      let headAfter = '';
      try {
        const col = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'lead' AND column_name = 'status'",
        );
        expect(col.rows.length).toBe(1);
        headAfter = (await git(root, ['rev-parse', 'HEAD'])).trim();
        expect(headAfter).not.toBe(headBefore.trim());

        // commit message carries field-level detail
        const msg = await git(root, ['log', '-1', '--format=%s%n%b']);
        expect(msg).toContain('chore(metadata): update schema');
        expect(msg).toContain('+ status');

        // schema.changed audit event (action/object/changes/meta.commitSha/actor)
        const audit = await pool.query(
          "SELECT actor_id, changes, meta FROM weavekit_audit WHERE action = 'schema.changed' AND object = 'lead' ORDER BY ts DESC LIMIT 1",
        );
        expect(audit.rows.length).toBe(1);
        const auditRow = audit.rows[0] as { actor_id: string; changes: unknown; meta: { commitSha?: string; alter?: boolean; ddlApplied?: boolean } };
        expect(auditRow.actor_id).toBe('Bot <bot@local>'); // commit author
        expect(JSON.stringify(auditRow.changes)).toContain('field.added');
        expect(JSON.stringify(auditRow.changes)).toContain('status');
        expect(auditRow.meta.commitSha).toBe(headAfter);
        expect(auditRow.meta.alter).toBe(true);
        expect(auditRow.meta.ddlApplied).toBe(true);
      } finally {
        await engine2.close();
      }
    } finally {
      await pool.query('DROP TABLE IF EXISTS lead, customer, weavekit_metadata, weavekit_meta CASCADE');
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
