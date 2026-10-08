import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from '../helpers/test.js';
import { createPool, inspectSchema, migrate, ObjectRegistry } from '../../src/core/index.js';
import { syncSchema } from '../../src/runtime/git/index.js';
import { deployPlan } from '../../src/cli/commands/deploy.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

async function writeSchemaDir(objects: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wk-deploy-'));
  for (const [name, def] of Object.entries(objects)) {
    const objDir = join(dir, 'objects', name);
    await mkdir(objDir, { recursive: true });
    await writeFile(join(objDir, 'schema.json'), JSON.stringify(def));
  }
  return dir;
}

maybe('Deploy / schema revision E2E (local PG)', () => {
  it('syncSchema records metadata cache + schema revision in one transaction, idempotent on re-run', async () => {
    const dir = await writeSchemaDir({
      depobj: { name: 'depobj', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'label', type: 'text' }] },
    });
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS depobj CASCADE');
      await pool.query(`DELETE FROM weavekit_metadata WHERE object_name = 'depobj'`);

      const first = await syncSchema({ dir, databaseUrl: url });
      expect(first.migration.statements.length).toBeGreaterThan(0);
      expect(first.schemaHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.revision?.created).toBe(true);
      expect(first.revision?.revision).toBeGreaterThan(0);

      const cache = await pool.query(`SELECT content_hash FROM weavekit_metadata WHERE object_name = 'depobj'`);
      expect(cache.rows).toHaveLength(1);
      const rev = await pool.query(
        `SELECT revision, content_hash, objects FROM weavekit_schema_revision ORDER BY revision DESC LIMIT 1`,
      );
      expect(rev.rows[0]).toMatchObject({ content_hash: first.schemaHash });
      expect(rev.rows[0].objects).toContain('depobj');

      // re-run: no DDL, same hash → no new revision
      const again = await syncSchema({ dir, databaseUrl: url });
      expect(again.migration.statements).toEqual([]);
      expect(again.revision?.created).toBe(false);
      expect(again.revision?.revision).toBe(first.revision?.revision);
    } finally {
      await pool.query('DROP TABLE IF EXISTS depobj CASCADE');
      await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deployPlan reports impact analysis + config drift', async () => {
    const dir = await writeSchemaDir({
      planobj: { name: 'planobj', alter: true, fields: [{ name: 'id', type: 'string', primary: true }, { name: 'note', type: 'text' }] },
    });
    await writeFile(join(dir, 'weavekit.config.ts'), `export default { databaseUrl: process.env.DATABASE_URL };\n`);
    const pool = createPool(url!);
    const capture: { payload: unknown } = { payload: undefined };
    const printer = {
      json: true,
      kv() {},
      table() {},
      log() {},
      error() {},
      data(payload: unknown) {
        capture.payload = payload;
      },
    };
    try {
      await pool.query('DROP TABLE IF EXISTS planobj CASCADE');
      await pool.query(`DELETE FROM weavekit_metadata WHERE object_name = 'planobj'`);

      // before apply: the new table is a create (low risk)
      await deployPlan(dir, { printer: printer as never });
      const first = capture.payload as { impact: { creates: string[]; dataCompat: { risk: string } } };
      expect(first.impact.creates).toContain('planobj');
      expect(first.impact.dataCompat.risk).toBe('low');

      // apply, then add a column on disk → additive change + revision drift
      await syncSchema({ dir, databaseUrl: url });
      await writeFile(
        join(dir, 'objects', 'planobj', 'schema.json'),
        JSON.stringify({
          name: 'planobj',
          alter: true,
          fields: [
            { name: 'id', type: 'string', primary: true },
            { name: 'note', type: 'text' },
            { name: 'tag', type: 'text' },
          ],
        }),
      );
      await deployPlan(dir, { printer: printer as never });
      const second = capture.payload as {
        statements: string[];
        impact: { columnAdds: unknown[]; dataCompat: { risk: string } };
        configDrift: boolean;
      };
      expect(second.statements.some((s) => s.includes('ADD COLUMN'))).toBe(true);
      expect(second.impact.columnAdds).toHaveLength(1);
      expect(second.impact.dataCompat.risk).toBe('medium');
      expect(second.configDrift).toBe(true);
    } finally {
      await pool.query('DROP TABLE IF EXISTS planobj CASCADE');
      await pool.query(`DELETE FROM weavekit_metadata WHERE object_name = 'planobj'`);
      await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('an onCommit failure rolls back the DDL (atomic deploy)', async () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'deploy_rollback_probe', fields: [{ name: 'id', type: 'string', primary: true }] });
    let threw = false;
    try {
      await migrate(reg, {
        databaseUrl: url,
        onCommit: async () => {
          throw new Error('boom');
        },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const pool = createPool(url!);
    try {
      const actual = await inspectSchema(pool);
      expect(actual.has('deploy_rollback_probe')).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
