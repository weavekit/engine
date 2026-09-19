import { describe, it, expect } from '../helpers/test.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FIELD_TYPES, ObjectRegistry, createPool, migrate } from '../../src/core/index.js';
import { createDataAccess } from '../../src/runtime/data-access/index.js';
import { createScriptDispatcher } from '../../src/subsystems/script/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Script onLoad read hook E2E (real sandbox + real PG)', () => {
  it('onLoad batch-transforms returned records of find/findOne/create/update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-onload-e2e-'));
    const objectsDir = join(root, 'objects');
    await mkdir(join(objectsDir, 'scr_lead'), { recursive: true });
    await writeFile(
      join(objectsDir, 'scr_lead', 'server.js'),
      `export function onLoad() {
  for (const r of this.records) {
    r.decorated = true;
    r.label = String(r.title ?? '').toUpperCase();
  }
  return this.records;
}
`,
    );

    const registry = new ObjectRegistry();
    registry.register({
      name: 'scr_lead',
      fields: [
        { name: 'id', type: FIELD_TYPES.STRING, primary: true },
        { name: 'title', type: FIELD_TYPES.STRING },
        { name: 'amount', type: FIELD_TYPES.NUMBER },
      ],
    });

    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS "scr_lead", weavekit_meta CASCADE');
      await migrate(registry, { databaseUrl: url });

      const dataAccess = createDataAccess();
      const dispatcher = await createScriptDispatcher({
        objectsDir,
        registry,
        pool,
        dataAccess,
        config: { sandbox: { timeout: 3000, queryTimeout: 2000 } },
      });
      const scripted = createDataAccess({ script: dispatcher });
      const ctx = { pool, registry };

      // create returned record goes through onLoad
      const created = await scripted.create('scr_lead', { id: 'L1', title: 'hello', amount: 5 }, ctx);
      expect(created).toEqual(expect.objectContaining({ id: 'L1', decorated: true, label: 'HELLO' }));

      // find batch transform (total unaffected)
      await scripted.create('scr_lead', { id: 'L2', title: 'world', amount: 7 }, ctx);
      const found = await scripted.find('scr_lead', {}, ctx);
      expect(found.total).toBe(2);
      expect(found.rows).toHaveLength(2);
      expect(found.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'L1', decorated: true, label: 'HELLO' }),
          expect.objectContaining({ id: 'L2', decorated: true, label: 'WORLD' }),
        ]),
      );

      // findOne inherits (1-element batch)
      const one = await scripted.findOne('scr_lead', 'L1', ctx);
      expect(one).toEqual(expect.objectContaining({ id: 'L1', decorated: true, label: 'HELLO' }));

      // update returned record goes through onLoad
      const updated = await scripted.update('scr_lead', 'L1', { title: 'HELLO2' }, ctx);
      expect(updated).toEqual(expect.objectContaining({ id: 'L1', decorated: true, label: 'HELLO2' }));

      await dispatcher.close();
    } finally {
      await pool.query('DROP TABLE IF EXISTS "scr_lead", weavekit_meta CASCADE');
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
