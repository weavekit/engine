import type { ObjectDefinition } from '../types/index.js';
import { READ_SCOPES, ROW_SCOPE_MARKERS } from '../types/index.js';
import type { RowScopeMarker } from '../types/index.js';
import { sqlIdent } from '../storage/sql-literals.js';

const q = (id: string) => `"${id}"`;

/**
 * Row-level security policy generation for the script sandbox's restricted SQL
 * (`this.db.query`). The engine's own data access runs as the table owner, which
 * bypasses RLS (no `FORCE`), so row scoping stays in the application layer there.
 * `db.query` switches to a dedicated non-owner role (`SET LOCAL ROLE`) that IS
 * subject to RLS, and the subject is carried in session GUCs:
 *
 * - `weavekit.roles`         comma-joined role names
 * - `weavekit.actor_id`      subject id (own scope)
 * - `weavekit.department_id` subject department id (department scope)
 *
 * Unset GUCs resolve to NULL → the predicate is false → **0 rows (fail-closed)**.
 *
 * The predicate mirrors `resolvePermission` + `buildRowScope`: this is a second
 * encoding of the same matrix, so a parity test (db.objects vs db.query must
 * return the same rows for the same subject) guards against drift.
 *
 * Limitation: a script's `db.query` scopes `own`/`department` by flat equality
 * on the marked column (internal source). The recursive department subtree and
 * external-source translation are applied only by the application-layer
 * `buildRowScope`; use `db.objects` for those. (Flat equality is strictly
 * narrower, so RLS never over-exposes.)
 */

const POLICY_PREFIX = 'weavekit_read_';

export function policyName(def: ObjectDefinition): string {
  return `${POLICY_PREFIX}${def.name}`;
}

function roleIn(role: string): string {
  return `'${role.replace(/'/g, "''")}' = ANY (string_to_array(current_setting('weavekit.roles', true), ','))`;
}

function markerField(def: ObjectDefinition, marker: RowScopeMarker): string | undefined {
  return def.fields.find((f) => (f as unknown as Record<string, boolean>)[marker] === true)?.name;
}

/**
 * The read-policy predicate for one object, or `undefined` when no declared role
 * can read (default deny — no policy is created, RLS denies everything).
 */
export function buildRlsPolicy(def: ObjectDefinition): string | undefined {
  if (def.permissions === undefined) {
    // open mode — any subject reaching the role-gated db.query path may read all rows
    return 'true';
  }
  const clauses: string[] = [];
  for (const [role, p] of Object.entries(def.permissions)) {
    if (p.read === undefined) continue;
    if (p.read === READ_SCOPES.ALL) {
      clauses.push(roleIn(role));
    } else if (p.read === READ_SCOPES.OWN) {
      const field = markerField(def, ROW_SCOPE_MARKERS.OWNERSHIP);
      if (field !== undefined) {
        clauses.push(`(${roleIn(role)} AND current_setting('weavekit.actor_id', true) = ${q(field)})`);
      }
    } else if (p.read === READ_SCOPES.DEPARTMENT) {
      const field = markerField(def, ROW_SCOPE_MARKERS.DEPARTMENT);
      if (field !== undefined) {
        clauses.push(`(${roleIn(role)} AND current_setting('weavekit.department_id', true) = ${q(field)})`);
      }
    }
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' OR ')})`;
}

/** the policy DDL for a fresh table (drop+create keeps it idempotent across runs) */
export function buildRlsPolicyDdl(def: ObjectDefinition): string[] {
  const name = policyName(def);
  const policy = buildRlsPolicy(def);
  const stmts: string[] = [`DROP POLICY IF EXISTS ${name} ON ${q(def.name)};`];
  if (policy !== undefined) {
    stmts.push(`CREATE POLICY ${name} ON ${q(def.name)} FOR SELECT USING (${policy});`);
  }
  return stmts;
}

/** GRANT the restricted-SQL role read access to one object */
export function buildRlsGrantDdl(def: ObjectDefinition, role: string): string {
  return `GRANT SELECT ON ${q(def.name)} TO ${sqlIdent(role)};`;
}

/** the restricted-SQL role name shape (`weavekit_query`, …) */
const RLS_ROLE_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * PostgreSQL reserved keywords (Appendix C, "reserved" + "reserved, can be
 * function or type name"). Rejected as a role name so a config typo can never
 * produce an ambiguous DDL token; identifiers are also quoted below, so an
 * accepted name is always emitted safely.
 */
const RESERVED_SQL_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric',
  'authorization', 'binary', 'both', 'case', 'cast', 'check', 'collate',
  'collation', 'column', 'concurrently', 'constraint', 'create', 'cross',
  'current_catalog', 'current_date', 'current_role', 'current_schema',
  'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for',
  'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike',
  'in', 'initially', 'inner', 'intersect', 'into', 'is', 'isnull', 'join',
  'lateral', 'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp',
  'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'over', 'overlaps', 'placing', 'primary', 'references', 'returning',
  'right', 'select', 'session_user', 'similar', 'some', 'symmetric', 'table',
  'tablesample', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user',
  'using', 'variadic', 'verbose', 'when', 'where', 'window', 'with',
]);

/** PostgreSQL pseudo-roles that cannot be created / used as a target role */
const PSEUDO_ROLES: ReadonlySet<string> = new Set<string>([
  'public', 'current_user', 'session_user', 'current_role', 'current_catalog',
  'current_schema', 'none', 'group',
]);

/**
 * True when `role` is a safe, non-reserved identifier for `SET LOCAL ROLE` /
 * `CREATE ROLE`. The name is always emitted quoted (`sqlIdent`), so this guards
 * against pseudo-roles and reserved keywords rather than injection.
 */
export function isSafeRlsRole(role: string): boolean {
  const lower = role.toLowerCase();
  return RLS_ROLE_RE.test(role) && !RESERVED_SQL_KEYWORDS.has(lower) && !PSEUDO_ROLES.has(lower);
}
