import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from '../helpers/test.js';
import { createPool, migrate, recordMetaTableName } from '../../src/core/index.js';
import { loadSchemaDir } from '../../src/runtime/git/index.js';
import { runDoctor } from '../../src/cli/commands/doctor.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const SCHEMA = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
  ],
};

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wk-doctor-'));
  await mkdir(join(dir, 'objects', 'lead'), { recursive: true });
  await writeFile(join(dir, 'objects', 'lead', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
  await writeFile(
    join(dir, 'weavekit.config.ts'),
    `export default { databaseUrl: process.env.DATABASE_URL };\n`,
  );
  return dir;
}

/**
 * `weave doctor` preflight against real PostgreSQL. `behind` the fixture is
 * freshly created so drift is reported before migrate and cleared after.
 */
maybe('weave doctor preflight (real PG)', () => {
  it('reports connection/version, drift before migrate, then clean after', async () => {
    const dir = await makeProject();
    try {
      // a missing config is a hard failure
      const emptyDir = await mkdtemp(join(tmpdir(), 'wk-doctor-empty-'));
      try {
        const bad = await runDoctor(emptyDir);
        expect(bad.ok).toBe(false);
        expect(bad.checks.find((c) => c.name === 'config')?.status).toBe('fail');
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }

      // before migrate: tables missing → drift warn (never a fail)
      const before = await runDoctor(dir);
      const byName = (r: typeof before, name: string) => r.checks.find((c) => c.name === name);
      expect(byName(before, 'connection')?.status).toBe('pass');
      expect(byName(before, 'postgres-version')?.status).toBe('pass');
      expect(byName(before, 'schema-drift')?.status).toBe('warn');
      expect(byName(before, 'rls-role')?.status).toBe('skip');
      expect(byName(before, 'sandbox')?.status).toBe('skip');

      // apply the schema, then doctor should be clean
      const { registry } = await loadSchemaDir(dir, {});
      await migrate(registry, { databaseUrl: url! });

      const after = await runDoctor(dir);
      expect(byName(after, 'schema-drift')?.status).toBe('pass');
      expect(after.ok).toBe(true);
    } finally {
      const pool = createPool(url!);
      try {
        await pool.query(`DROP TABLE IF EXISTS "lead" CASCADE`);
        await pool.query(`DROP TABLE IF EXISTS "${recordMetaTableName('lead')}" CASCADE`);
      } finally {
        await pool.end();
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});
