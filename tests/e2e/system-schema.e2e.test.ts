import { describe, it, expect } from '../helpers/test.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import { createDataAccess, createPool, migrate, ObjectRegistry, searchPathOptions } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

/** `EngineConfig.systemSchema`: engine tables in a dedicated schema; runtime resolves via search_path */
maybe('dedicated system schema (local PG)', () => {
  it('migrate provisions engine tables in the system schema; runtime resolves them', async () => {
    const registry = new ObjectRegistry();
    registry.register({
      name: 'sslead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'title', type: 'string' },
      ],
    });
    const admin = createPool(url!);
    const cleanup = async (): Promise<void> => {
      await admin.query('DROP SCHEMA IF EXISTS weavekit CASCADE');
      await admin.query('DROP SCHEMA IF EXISTS app CASCADE');
      await admin.query('DROP TABLE IF EXISTS sslead CASCADE');
      await admin.query('DROP TABLE IF EXISTS "weavekit_record__sslead" CASCADE');
    };
    try {
      await cleanup();
      await migrate(registry, { databaseUrl: url!, systemSchema: 'weavekit' });

      // engine tables land in `weavekit`; object tables stay in the object schema
      const placed = await admin.query(
        `SELECT to_regclass('"weavekit"."weavekit_meta"') AS meta,
                to_regclass('"weavekit"."weavekit_record__sslead"') AS record_meta,
                to_regclass('"weavekit"."sslead"') AS lead_in_system`,
      );
      const p = placed.rows[0] as { meta: string | null; record_meta: string | null; lead_in_system: string | null };
      expect(p.meta).not.toBeNull();
      expect(p.record_meta).not.toBeNull();
      expect(p.lead_in_system).toBeNull();

      // a runtime pool that carries the system schema on search_path resolves bare names
      const runtime = createPool(url!, searchPathOptions('weavekit'));
      try {
        const da = createDataAccess();
        const ctx = { pool: runtime, registry, principal: { kind: 'system' as const, capability: 'internal.admin' as const } };
        await da.create('sslead', { id: 'L1', title: 'A' }, ctx);
        const found = await da.find('sslead', {}, ctx);
        expect(found.total).toBe(1);
        expect(found.rows[0]).toMatchObject({ id: 'L1', title: 'A' });
        await da.update('sslead', encodeRecordKey(['L1']), { title: 'B' }, ctx);
        // the record-metadata side row was written into the system schema
        const meta = await runtime.query('SELECT count(*)::int AS n FROM "weavekit"."weavekit_record__sslead"');
        expect((meta.rows[0] as { n: number }).n).toBe(1);
      } finally {
        await runtime.end();
      }
    } finally {
      await cleanup();
      await admin.end();
    }
  }, 60000);

  it('keeps a non-public object schema (URL search_path) while appending the system schema', async () => {
    const registry = new ObjectRegistry();
    registry.register({
      name: 'sslead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'title', type: 'string' },
      ],
    });
    const admin = createPool(url!);
    // the connection carries the object schema on search_path; the engine must
    // append the system schema to it, not replace it
    const sep = url!.includes('?') ? '&' : '?';
    const appUrl = `${url!}${sep}options=${encodeURIComponent('-c search_path=app,public')}`;
    const cleanup = async (): Promise<void> => {
      await admin.query('DROP SCHEMA IF EXISTS weavekit CASCADE');
      await admin.query('DROP SCHEMA IF EXISTS app CASCADE');
    };
    try {
      await cleanup();
      await admin.query('CREATE SCHEMA app');
      await migrate(registry, { databaseUrl: appUrl, systemSchema: 'weavekit' });

      // engine tables in `weavekit`; object tables in the connection's object schema (`app`)
      const placed = await admin.query(
        `SELECT to_regclass('"weavekit"."weavekit_meta"') AS meta,
                to_regclass('"app"."sslead"') AS lead_in_app,
                to_regclass('"public"."sslead"') AS lead_in_public`,
      );
      const p = placed.rows[0] as { meta: string | null; lead_in_app: string | null; lead_in_public: string | null };
      expect(p.meta).not.toBeNull();
      expect(p.lead_in_app).not.toBeNull();
      expect(p.lead_in_public).toBeNull();

      const runtime = createPool(appUrl, searchPathOptions('weavekit'));
      try {
        const da = createDataAccess();
        const ctx = { pool: runtime, registry, principal: { kind: 'system' as const, capability: 'internal.admin' as const } };
        await da.create('sslead', { id: 'L1', title: 'A' }, ctx);
        const found = await da.find('sslead', {}, ctx);
        expect(found.total).toBe(1);
        expect(found.rows[0]).toMatchObject({ id: 'L1', title: 'A' });
      } finally {
        await runtime.end();
      }
    } finally {
      await cleanup();
      await admin.end();
    }
  }, 60000);
});
