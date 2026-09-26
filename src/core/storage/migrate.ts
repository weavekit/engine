import type { ObjectRegistry } from '../object/index.js';
import { systemObjects } from '../object/index.js';
import { FIELD_TYPES } from '../types/index.js';
import { SchemaError, primaryKeyOf } from '../types/index.js';
import { applyStatements } from './apply.js';
import { buildExpectedTable, diffAll, diffRls, diffTable } from './diff.js';
import type { ExpectedTable } from './diff.js';
import { inspectSchema } from './inspect.js';
import { ensureMetaTable, setMeta } from './meta.js';
import { createPool } from './pool.js';
import { buildRecordMetaTable } from './record-meta.js';

export interface MigrateOptions {
  /** postgres connection string; falls back to process.env.DATABASE_URL */
  databaseUrl?: string;
  /** generate SQL without executing */
  dryRun?: boolean;
  /**
   * enable row-level security for the restricted-SQL role (`this.db.query`).
   * `role` is the non-owner role db.query switches to via `SET LOCAL ROLE` so
   * RLS applies. Applied to new tables always, to existing tables only when
   * the object opts in (`schema.alter: true`) and the migrating role owns
   * them. The role is created best-effort (`CREATE ROLE IF NOT EXISTS` needs
   * CREATEROLE; failure degrades to a warning and RLS DDL is skipped).
   */
  rls?: { role: string };
}

export interface MigrationResult {
  /** generated DDL statements (empty when already in sync) */
  statements: string[];
  /** object names whose schema changed (audit trail) */
  applied: string[];
  dryRun: boolean;
  /** non-fatal issues (e.g. RLS role could not be created) */
  warnings: string[];
}

const RLS_ROLE_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Best-effort provisioning of the restricted-SQL role: `CREATE ROLE` (needs
 * CREATEROLE; failure → warning + false) and `GRANT` membership for
 * `SET LOCAL ROLE` (idempotent via pg_has_role). `CREATE ROLE` cannot run
 * inside a transaction, so this runs before the DDL transaction.
 */
async function provisionRlsRole(pool: import('pg').Pool, role: string, warnings: string[]): Promise<boolean> {
  const existing = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (existing.rows.length === 0) {
    try {
      await pool.query(`CREATE ROLE ${role}`);
    } catch {
      warnings.push(`could not create role "${role}" (needs CREATEROLE) — create it manually to enable RLS`);
      return false;
    }
  }
  try {
    await pool.query(
      `DO $$ BEGIN IF NOT pg_has_role(current_user, '${role}', 'MEMBER') THEN EXECUTE 'GRANT ${role} TO current_user'; END IF; END $$;`,
    );
  } catch (error) {
    warnings.push(`could not grant role "${role}" to current user: ${String((error as Error).message)}`);
  }
  return true;
}

/**
 * State-diff migration: compare each engine-managed object's expected table
 * against the live `information_schema`, generate DDL, apply inside a
 * transaction, and write `schema.applied.<object>` audit records.
 *
 * New objects (no table by that name in PostgreSQL) are created from schema.
 * Existing tables are read-only by default (fail-fast: every declared field
 * must exist as a column, or `object.field.columnMissing` is thrown). An
 * object opts into additive auto-DDL for its existing table with
 * `schema.alter: true` — then missing fields become ADD COLUMN etc. instead of
 * throwing. Never destructive: column types are never altered, columns never
 * dropped. Idempotent by construction — a second run yields no statements.
 */
export async function migrate(registry: ObjectRegistry, options: MigrateOptions = {}): Promise<MigrationResult> {
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const dryRun = options.dryRun ?? false;
  const warnings: string[] = [];

  const pool = createPool(url);
  try {
    const defs = new Map([...systemObjects(), ...registry.list()].map((d) => [d.name, d]));
    const actual = await inspectSchema(pool);

    if (options.rls !== undefined && !RLS_ROLE_RE.test(options.rls.role)) {
      throw new Error(`invalid RLS role name "${options.rls.role}"`);
    }

    // new objects (no live table by that name) are diffed and created; objects
    // that opted in via `alter: true` are diffed against their existing table
    // too (additive ALTER DDL only)
    const expected: ExpectedTable[] = [...defs.values()]
      .filter((d) => d.alter === true || actual.get(d.name) === undefined)
      .map((d) => buildExpectedTable(d, defs, registry.fieldTypes));

    const statements = diffAll(expected, actual);

    // engine-owned per-object record metadata side tables: one per object (R1),
    // created idempotently for every object regardless of `alter`/ownership —
    // they never touch the customer's own table
    const metaTables = [...defs.keys()].map((name) => buildRecordMetaTable(name));
    const metaStatements = diffAll(metaTables, actual);

    // existing tables are read-only unless the object opted in (`alter: true`):
    // verify every declared field is a live column (prevents REST/MCP pointing
    // at ghost columns). With `alter: true`, missing fields become ADD COLUMN
    // instead of throwing.
    for (const def of defs.values()) {
      const actualTable = actual.get(def.name);
      if (actualTable === undefined) continue; // new object, handled above
      const cols = new Set(actualTable.columns.map((c) => c.name));
      const pk = primaryKeyOf(def);
      if (pk === undefined || !cols.has(pk)) {
        // a table without its declared primary key is a misconfiguration the
        // engine must not paper over — always fail
        throw new SchemaError('object.primary.columnMissing', { object: def.name, table: def.name, column: pk });
      }
      if (def.alter === true) continue;
      for (const field of def.fields) {
        // details fields have no column on the parent (the child table carries
        // parent_id/parent_type/parent_idx) — never a ghost-column check
        if (field.type === FIELD_TYPES.DETAILS) continue;
        if (!cols.has(field.name)) {
          throw new SchemaError('object.field.columnMissing', { object: def.name, table: def.name, field: field.name });
        }
      }
    }

    const applied = expected.filter((t) => diffTable(t, actual.get(t.name)).length > 0).map((t) => t.name);

    // row-level security for the restricted-SQL role: provision the role
    // (non-transactional) then diff the policy against the live RLS state.
    // New tables always; existing tables only under `alter` and when the
    // migrating role owns them (a non-owner table's RLS would also apply to the
    // engine's own data-access path and break it).
    let rlsStatements: string[] = [];
    if (options.rls !== undefined) {
      const roleReady = await provisionRlsRole(pool, options.rls.role, warnings);
      if (roleReady) {
        const { rows } = await pool.query('SELECT current_user AS u');
        const currentUser = String((rows[0] as { u: string }).u);
        for (const def of defs.values()) {
          const actualTable = actual.get(def.name);
          const applies = actualTable === undefined || (def.alter === true && actualTable.owner === currentUser);
          if (!applies) {
            if (actualTable !== undefined) {
              warnings.push(`skip RLS on "${def.name}": not owned by ${currentUser} (run migrate as the table owner)`);
            }
            continue;
          }
          rlsStatements = rlsStatements.concat(diffRls(def, actualTable, options.rls.role));
        }
      }
    }

    const allStatements = [...statements, ...metaStatements, ...rlsStatements];

    if (!dryRun && allStatements.length > 0) {
      await ensureMetaTable(pool);
      await applyStatements(pool, allStatements);
      const ts = new Date().toISOString();
      for (const name of applied) await setMeta(pool, `schema.applied.${name}`, ts);
    }

    return { statements: allStatements, applied, dryRun, warnings };
  } finally {
    await pool.end();
  }
}
