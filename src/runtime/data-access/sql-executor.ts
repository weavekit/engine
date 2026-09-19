import type { Pool } from 'pg';
import { SchemaError } from '../../core/index.js';

export interface RestrictedSqlSubject {
  id: string;
  roles: string[];
  teamId?: string;
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
}

export interface RestrictedSqlResult {
  rows: unknown[];
}

const MAX_ROWS_DEFAULT = 1000;
const TIMEOUT_DEFAULT = 2000;
const RLS_ROLE_RE = /^[a-z_][a-z0-9_]*$/;

function gucLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Controlled SQL execution for sandbox scripts (`this.db.query`).
 *
 * Gates:
 * - SELECT-only — any other statement is rejected before touching the pool
 * - single statement — a `;` anywhere (after stripping one trailing) is rejected
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
  const maxRows = options.maxRows ?? MAX_ROWS_DEFAULT;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_DEFAULT;

  if (typeof sql !== 'string') {
    throw new SchemaError('script.query.invalid', { detail: 'sql must be a string' });
  }
  let trimmed = sql.trim();
  if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1);
  if (!/^SELECT\s/i.test(trimmed)) {
    throw new SchemaError('script.query.invalid', { detail: 'only SELECT statements are allowed' });
  }
  if (trimmed.includes(';')) {
    throw new SchemaError('script.query.invalid', { detail: 'multiple statements are not allowed' });
  }
  if (options.rls !== undefined && !RLS_ROLE_RE.test(options.rls.role)) {
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
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SET LOCAL weavekit.actor_id = ${gucLiteral(subject.id)}`);
      await client.query(`SET LOCAL weavekit.roles = ${gucLiteral(subject.roles.join(','))}`);
      if (subject.teamId !== undefined) {
        await client.query(`SET LOCAL weavekit.team_id = ${gucLiteral(subject.teamId)}`);
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
