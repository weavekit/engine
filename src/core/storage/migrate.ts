import type { ObjectRegistry } from '../object/index.js';
import { systemObjects } from '../object/index.js';
import type { ObjectDefinition } from '../types/index.js';
import { FIELD_TYPES } from '../types/index.js';
import { SchemaError, primaryKeyOf } from '../types/index.js';
import { applyStatements } from './apply.js';
import { buildExpectedTable, diffAll, diffRls, diffTable } from './diff.js';
import type { ExpectedTable } from './diff.js';
import { inspectSchema } from './inspect.js';
import { buildLinkTables } from './link-table.js';
import { setMeta } from './meta.js';
import { createPool } from './pool.js';
import { buildRecordMetaTable } from './record-meta.js';
import { sqlIdent, sqlLiteral } from './sql-literals.js';
import { SYSTEM_TABLES, buildSystemTables, systemHardeningStatements } from './system-tables.js';
import { isSafeRlsRole } from '../rbac/index.js';

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

const q = (id: string) => `"${id}"`;

/**
 * DDL to ensure the native enum types referenced by managed objects exist.
 * `CREATE TYPE` when the type is missing; `ALTER TYPE … ADD VALUE IF NOT EXISTS`
 * only for managed (created / `alter: true`) objects — never for adopted,
 * read-only tables (the engine must not ALTER a customer's type).
 */
async function buildEnumStatements(
  pool: import('pg').Pool,
  defs: Map<string, ObjectDefinition>,
  managed: ReadonlySet<string>,
): Promise<string[]> {
  const declared = new Map<string, Set<string>>();
  for (const def of defs.values()) {
    if (!managed.has(def.name)) continue;
    for (const field of def.fields) {
      const e = field as { type: string; options?: unknown; enumType?: string };
      if (e.type !== FIELD_TYPES.ENUM || e.enumType === undefined || !Array.isArray(e.options)) continue;
      const set = declared.get(e.enumType) ?? new Set<string>();
      for (const option of e.options) set.add(String(option));
      declared.set(e.enumType, set);
    }
  }
  if (declared.size === 0) return [];

  const res = await pool.query(
    `SELECT t.typname AS name, e.enumlabel AS label
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typtype = 'e'`,
  );
  const existing = new Map<string, Set<string>>();
  for (const row of res.rows as { name: string; label: string }[]) {
    const set = existing.get(row.name) ?? new Set<string>();
    set.add(row.label);
    existing.set(row.name, set);
  }

  const statements: string[] = [];
  for (const [name, options] of declared) {
    const labels = existing.get(name);
    if (labels === undefined) {
      statements.push(`CREATE TYPE ${q(name)} AS ENUM (${[...options].map(sqlLiteral).join(', ')})`);
    } else {
      for (const option of options) {
        if (!labels.has(option)) statements.push(`ALTER TYPE ${q(name)} ADD VALUE IF NOT EXISTS ${sqlLiteral(option)}`);
      }
    }
  }
  return statements;
}

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
      await pool.query(`CREATE ROLE ${sqlIdent(role)}`);
    } catch {
      warnings.push(`could not create role "${role}" (needs CREATEROLE) — create it manually to enable RLS`);
      return false;
    }
  }
  try {
    // no dynamic SQL: decide membership in JS, then GRANT with a quoted identifier
    const res = await pool.query(`SELECT pg_has_role(current_user, $1, 'MEMBER') AS member`, [role]);
    if ((res.rows[0] as { member: boolean }).member !== true) {
      await pool.query(`GRANT ${sqlIdent(role)} TO current_user`);
    }
  } catch (error) {
    warnings.push(`could not grant role "${role}" to current user: ${String((error as Error).message)}`);
  }
  return true;
}

/**
 * True when `PUBLIC` still holds `TRUNCATE` on `table`, i.e. the append-only
 * hardening `REVOKE` is worth emitting. New tables grant nothing to `PUBLIC`
 * by default, so a clean run emits no hardening statement (keeps migrate
 * idempotent).
 */
async function publicHasTruncate(pool: import('pg').Pool, table: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       WHERE c.oid = to_regclass($1) AND a.grantee = 0 AND a.privilege_type = 'TRUNCATE'
     ) AS needs`,
    [table],
  );
  return (res.rows[0] as { needs: boolean } | undefined)?.needs === true;
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

    if (options.rls !== undefined && !isSafeRlsRole(options.rls.role)) {
      throw new Error(`invalid RLS role name "${options.rls.role}"`);
    }

    // new objects (no live table by that name) are diffed and created; objects
    // that opted in via `alter: true` are diffed against their existing table
    // too (additive ALTER DDL only)
    const expected: ExpectedTable[] = [...defs.values()]
      .filter((d) => d.alter === true || actual.get(d.name) === undefined)
      .map((d) => buildExpectedTable(d, defs, registry.fieldTypes));

    const statements = diffAll(expected, actual);

    // native enum types must exist before the tables that reference them
    const enumStatements = await buildEnumStatements(pool, defs, new Set(expected.map((t) => t.name)));

    // engine-owned per-object record metadata side tables: one per object (R1),
    // created idempotently for every object regardless of `alter`/ownership —
    // they never touch the customer's own table
    const metaTables = [...defs.keys()].map((name) => buildRecordMetaTable(name));
    const metaStatements = diffAll(metaTables, actual);

    // engine-owned many-to-many link tables for every `multiRelation` field:
    // one per (object, field), created idempotently regardless of `alter`.
    const linkTables = buildLinkTables(defs, registry.fieldTypes);
    const linkStatements = diffAll(linkTables, actual);

    // engine-owned system tables (metadata cache / seq / audit / approvals /
    // timers / counters) + their ACL hardening: provisioned here (and only
    // here) so the runtime never runs DDL and can be least-privileged.
    const systemStatements = diffAll(buildSystemTables(), actual);
    const hardening = (await publicHasTruncate(pool, SYSTEM_TABLES.AUDIT)) ? systemHardeningStatements() : [];

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
        // parent_id/parent_type/parent_idx); multiRelation fields have no column
        // either (a link table carries the pairs) — never ghost-column checks
        if (field.type === FIELD_TYPES.DETAILS || field.type === FIELD_TYPES.MULTI_RELATION) continue;
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
        for (const def of registry.list()) {
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
        // link tables are engine plumbing (never registry-visible): enable
        // RLS with no policy so the restricted role reads 0 rows even if it is
        // ever granted, a second layer behind the sql-gate. The engine runs as
        // the owner and bypasses RLS, so its own reads are unaffected.
        for (const table of linkTables) {
          if (actual.get(table.name)?.rlsEnabled !== true) {
            rlsStatements.push(`ALTER TABLE ${q(table.name)} ENABLE ROW LEVEL SECURITY;`);
          }
        }
      }
    }

    const allStatements = [
      ...enumStatements,
      ...statements,
      ...metaStatements,
      ...linkStatements,
      ...systemStatements,
      ...rlsStatements,
      ...hardening,
    ];

    if (!dryRun && allStatements.length > 0) {
      await applyStatements(pool, allStatements);
      const ts = new Date().toISOString();
      for (const name of applied) await setMeta(pool, `schema.applied.${name}`, ts);
    }

    // content-address every object's workflow definition (append-only, idempotent)
    // so running instances can resolve the exact revision they were pinned to.
    if (!dryRun) await registerWorkflowDefinitions(pool, defs);

    return { statements: allStatements, applied, dryRun, warnings };
  } finally {
    await pool.end();
  }
}

/**
 * Upsert each object's current workflow definition into
 * `weavekit_workflow_definitions` (keyed by content hash). Idempotent; the
 * `version_seq` is a monotonic display/switch ordinal. Never rewrites or drops
 * an existing row (append-only revision history for instance pinning).
 */
async function registerWorkflowDefinitions(
  pool: import('pg').Pool,
  defs: ReadonlyMap<string, ObjectDefinition>,
): Promise<void> {
  const table = q(SYSTEM_TABLES.WORKFLOW_DEFINITIONS);
  for (const def of defs.values()) {
    if (def.workflow === undefined || def.workflowHash === undefined) continue;
    await pool.query(
      `INSERT INTO ${table} (object, hash, version_seq, definition)
       VALUES ($1, $2, (SELECT COALESCE(MAX(version_seq), 0) + 1 FROM ${table} WHERE object = $1), $3::jsonb)
       ON CONFLICT (object, hash) DO NOTHING`,
      [def.name, def.workflowHash, JSON.stringify(def.workflow)],
    );
  }
}
