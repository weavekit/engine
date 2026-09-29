import { describe, it, afterEach, expect } from '../helpers/test.js';
import {
  SYSTEM_TABLES,
  SYSTEM_TABLE_NAMES,
  buildSystemTables,
  systemHardeningStatements,
} from '../../src/core/storage/system-tables.js';
import {
  resolveRequireRestrictedAccount,
  assertRestrictedRuntimeAccount,
} from '../../src/runtime/engine.js';
import { SchemaError } from '../../src/core/index.js';
import type { Pool } from 'pg';

const ENV_KEY = 'WEAVEKIT_REQUIRE_RESTRICTED_ACCOUNT';
const savedEnv = process.env[ENV_KEY];

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

function fakePool(row: { user: string; can_create: boolean }): Pool {
  return { query: async () => ({ rows: [row] }) } as unknown as Pool;
}

describe('engine system tables (migrate-owned)', () => {
  it('exposes every system table with a primary key', () => {
    const tables = buildSystemTables();
    expect(new Set(tables.map((t) => t.name))).toEqual(new Set(SYSTEM_TABLE_NAMES));
    for (const t of tables) {
      expect(t.columns.some((c) => c.primary)).toBe(true);
    }
  });

  it('tracks the audit trail as append-only via hardening statements', () => {
    const stmts = systemHardeningStatements();
    expect(stmts.some((s) => s.includes('REVOKE TRUNCATE') && s.includes(SYSTEM_TABLES.AUDIT))).toBe(true);
  });

  it('covers the metadata cache / seq / audit / approvals / workflow / timers / counters / meta tables', () => {
    const names = buildSystemTables().map((t) => t.name);
    expect(names).toContain(SYSTEM_TABLES.METADATA);
    expect(names).toContain(SYSTEM_TABLES.SEQ);
    expect(names).toContain(SYSTEM_TABLES.AUDIT);
    expect(names).toContain(SYSTEM_TABLES.APPROVALS);
    expect(names).toContain(SYSTEM_TABLES.WORKFLOW_DEFINITIONS);
    expect(names).toContain(SYSTEM_TABLES.WORKFLOW_INSTANCES);
    expect(names).toContain(SYSTEM_TABLES.WORKFLOW_STEPS);
    expect(names).toContain(SYSTEM_TABLES.WORKFLOW_WORKITEMS);
    expect(names).toContain(SYSTEM_TABLES.WORKFLOW_LOCKS);
    expect(names).toContain(SYSTEM_TABLES.WORKFLOW_TIMERS);
    expect(names).toContain(SYSTEM_TABLES.COUNTERS);
    expect(names).toContain(SYSTEM_TABLES.META);
  });
});

describe('runtime account guard', () => {
  it('defaults to requiring a restricted account', () => {
    delete process.env[ENV_KEY];
    expect(resolveRequireRestrictedAccount({})).toBe(true);
  });

  it('explicit config wins over the env var', () => {
    process.env[ENV_KEY] = 'true';
    expect(resolveRequireRestrictedAccount({ runtime: { requireRestrictedAccount: false } })).toBe(false);
  });

  it('env var can relax the default', () => {
    process.env[ENV_KEY] = 'false';
    expect(resolveRequireRestrictedAccount({})).toBe(false);
  });

  it('fails closed when the account can create objects', async () => {
    delete process.env[ENV_KEY];
    let caught: unknown;
    try {
      await assertRestrictedRuntimeAccount(fakePool({ user: 'postgres', can_create: true }), {}, 'en');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    expect((caught as SchemaError).code).toBe('engine.runtimeAccount.ddlAllowed');
  });

  it('passes when the account cannot create objects', async () => {
    delete process.env[ENV_KEY];
    await assertRestrictedRuntimeAccount(fakePool({ user: 'weavekit_runtime', can_create: false }), {}, 'en');
  });

  it('is bypassed when requireRestrictedAccount is false', async () => {
    delete process.env[ENV_KEY];
    await assertRestrictedRuntimeAccount(fakePool({ user: 'postgres', can_create: true }), {
      runtime: { requireRestrictedAccount: false },
    }, 'en');
  });
});
