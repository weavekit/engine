import type { Pool } from 'pg';
import { isSafeRlsRole, sqlIdent, SchemaError } from '../../core/index.js';
import type { Locale } from '../../core/index.js';
import { createSqlAnalyzer } from '../sql-analyzer/index.js';
import type { SqlAnalyzer } from '../sql-analyzer/index.js';
import type { QueryBudget } from './query-budget.js';

export interface RestrictedSqlSubject {
  id: string;
  roles: string[];
  departmentId?: string;
  /** tenant of the subject (multi-tenancy); carried to RLS via `weavekit.tenant_id` */
  tenantId?: string;
}

export interface RestrictedSqlRls {
  /** non-owner role to switch to via `SET LOCAL ROLE` so PostgreSQL RLS applies */
  role: string;
  /** the script author; carried to RLS policies via `weavekit.*` session GUCs */
  subject: RestrictedSqlSubject;
}

export interface RestrictedSqlOptions {
  /** maximum rows returned; defaults to 1000 */
  maxRows?: number;
  /** server-side statement timeout in ms; defaults to 2000 */
  timeoutMs?: number;
  /**
   * row-level security wrapper: runs the query in a transaction under
   * `SET LOCAL ROLE <role>` with `weavekit.actor_id/roles/team_id` GUCs so the
   * table's RLS policies scope the result rows. Unset GUCs make policies deny
   * (0 rows) — fail-closed.
   */
  rls?: RestrictedSqlRls;
  /** analyzer used for the mandatory SELECT-only gate; defaults to a shared instance */
  analyzer?: SqlAnalyzer;
  /** message locale for gate failures */
  locale?: Locale;
  /** query budget: caps maxRows / maxSqlLength / maxJoins / statementTimeoutMs */
  budget?: QueryBudget;
}

export interface RestrictedSqlResult {
  rows: unknown[];
}

const MAX_ROWS_DEFAULT = 1000;
const TIMEOUT_DEFAULT = 2000;

function gucLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** shared analyzer for callers that don't inject one (WASM is initialized once) */
let sharedAnalyzer: SqlAnalyzer | undefined;
function defaultAnalyzer(): SqlAnalyzer {
  return (sharedAnalyzer ??= createSqlAnalyzer());
}

/**
 * Controlled SQL execution for sandbox scripts (`this.db.query`).
 *
 * Gates:
 * - SELECT-only — enforced by the AST analyzer (`analyzeSelect`), which is the
 *   single source: exactly one statement, a `SelectStmt` root, no nested DML,
 *   no denied functions, bounded AST. A raw regex is not used (it is both
 *   bypassable and over-restrictive). The script bridge runs `analyzeSelect`
 *   too, but for a different purpose (its RBAC table/column gate); the executor
 *   re-runs it so a direct caller cannot bypass the SELECT-only boundary.
 * - row cap — the query is wrapped in a subquery and the outer LIMIT is
 *   clamped to `maxRows`, so a runaway result can never flood the response
 * - server-side timeout — runs on a dedicated pooled client with
 *   `statement_timeout`, so a slow query is cancelled by PostgreSQL itself
 * - row-level security — with `rls`, the query runs in a transaction under
 *   `SET LOCAL ROLE <role>` + `weavekit.*` GUCs, so RLS policies scope the rows
 *   (column-level `exclude` is enforced by the application-layer SQL gate before
 *   this function runs)
 */
export async function executeRestrictedSql(
  pool: Pool,
  sql: string,
  params: unknown[],
  options: RestrictedSqlOptions = {},
): Promise<RestrictedSqlResult> {
  const maxRows = options.maxRows ?? options.budget?.maxRows ?? MAX_ROWS_DEFAULT;
  const timeoutMs = options.timeoutMs ?? options.budget?.statementTimeoutMs ?? TIMEOUT_DEFAULT;

  if (typeof sql !== 'string') {
    throw new SchemaError('script.query.invalid', { detail: 'sql must be a string' });
  }
  let trimmed = sql.trim();
  if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1);
  if (options.budget !== undefined && trimmed.length > options.budget.maxSqlLength) {
    throw new SchemaError('query.budget.exceeded', { limit: 'sqlLength', max: options.budget.maxSqlLength }, options.locale);
  }
  // mandatory AST gate (fail-closed): the analyzer — not a regex — is the single
  // SELECT-only check, so a direct caller cannot run a non-SELECT or multi-statement.
  const analysis = await (options.analyzer ?? defaultAnalyzer()).analyzeSelect(trimmed, options.locale);
  if (options.budget !== undefined && analysis.joinCount > options.budget.maxJoins) {
    throw new SchemaError('query.budget.exceeded', { limit: 'joins', max: options.budget.maxJoins }, options.locale);
  }
  if (options.rls !== undefined && !isSafeRlsRole(options.rls.role)) {
    throw new SchemaError('script.query.invalid', { detail: `invalid RLS role "${options.rls.role}"` });
  }

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    if (options.rls !== undefined) {
      const { role, subject } = options.rls;
      await client.query(`SET LOCAL ROLE ${sqlIdent(role)}`);
      await client.query(`SET LOCAL weavekit.actor_id = ${gucLiteral(subject.id)}`);
      await client.query(`SET LOCAL weavekit.roles = ${gucLiteral(subject.roles.join(','))}`);
      if (subject.departmentId !== undefined) {
        await client.query(`SET LOCAL weavekit.department_id = ${gucLiteral(subject.departmentId)}`);
      }
      if (subject.tenantId !== undefined) {
        await client.query(`SET LOCAL weavekit.tenant_id = ${gucLiteral(subject.tenantId)}`);
      }
    }
    const result = await client.query(
      `SELECT * FROM (${trimmed}) AS __restricted__ LIMIT $${params.length + 1}`,
      [...params, maxRows],
    );
    await client.query('COMMIT');
    inTransaction = false;
    return { rows: result.rows as unknown[] };
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // the client may be broken after a timeout — release and move on
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
