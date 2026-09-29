import { describe, it, after, expect } from '../helpers/test.js';
import {
  buildEngineFromRegistry,
  createPool,
  inspectSchema,
  migrate,
  ObjectRegistry,
  SYSTEM_TABLE_NAMES,
} from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const ENV_KEY = 'WEAVEKIT_REQUIRE_RESTRICTED_ACCOUNT';
const savedEnv = process.env[ENV_KEY];

after(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

maybe('System tables + runtime account guard E2E (local PG)', () => {
  it('a single `weave migrate` provisions every system table, idempotently', async () => {
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS ${SYSTEM_TABLE_NAMES.join(', ')} CASCADE`);
      const first = await migrate(new ObjectRegistry(), { databaseUrl: url! });
      expect(first.statements.length).toBeGreaterThan(0);

      const actual = await inspectSchema(pool);
      for (const name of SYSTEM_TABLE_NAMES) {
        expect(actual.has(name)).toBe(true);
      }

      const again = await migrate(new ObjectRegistry(), { databaseUrl: url! });
      expect(again.statements).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('refuses to start when the runtime account can create objects (default fail)', async () => {
    process.env[ENV_KEY] = 'true';
    let caught: unknown;
    try {
      await buildEngineFromRegistry(new ObjectRegistry(), {
        databaseUrl: url!,
        auth: { source: { 'k': { id: 'u1', roles: ['admin'] } } },
        runtime: { requireRestrictedAccount: true },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('engine.runtimeAccount.ddlAllowed');
  });

  it('starts when the guard is relaxed for a single-account setup', async () => {
    const engine = await buildEngineFromRegistry(new ObjectRegistry(), {
      databaseUrl: url!,
      auth: { source: { 'k': { id: 'u1', roles: ['admin'] } } },
      runtime: { requireRestrictedAccount: false },
    });
    await engine.close();
  });

  it('clean up system tables', async () => {
    const pool = createPool(url!);
    try {
      await pool.query(`DROP TABLE IF EXISTS ${SYSTEM_TABLE_NAMES.join(', ')} CASCADE`);
    } finally {
      await pool.end();
    }
  });
});
