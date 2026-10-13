import { createHash } from 'node:crypto';
import type { ObjectDefinition, ReadScope } from '../types/index.js';
import { READ_SCOPES, ROW_SCOPE_MARKERS } from '../types/index.js';
import type { RowScopeMarker } from '../types/index.js';
import { sqlIdent } from '../storage/sql-literals.js';
import { scopeFieldName } from './scopeMarker.js';
import { buildRowScopeFor, resolvePermissionFor, type ObjectLookup } from './details.js';
import type { ResolvedPermission } from './resolve.js';

const q = (id: string) => `"${id}"`;

/**
 * Row-level security policy generation for the script sandbox's restricted SQL
 * (`this.db.query`). The engine's own data access normally runs as the table
 * owner, which bypasses RLS (no `FORCE`), so row scoping stays in the application
 * layer there — **except** under `EngineConfig.rls.enforce`, where the engine's
 * customer-table access runs under the object role (see object-path RLS below).
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
 * can read (default deny — no policy is created, RLS denies everything). When the
 * object declares a scope column, a scope predicate (`weavekit.scope_id` GUC)
 * is AND'd on top — an unset GUC is NULL → fail-closed.
 */
export function buildRlsPolicy(def: ObjectDefinition): string | undefined {
  const base = baseRlsPolicy(def);
  if (base === undefined) return undefined;
  const field = scopeFieldName(def);
  if (field === undefined) return base;
  // the row-scope key is carried by the `weavekit.scope_id` session GUC
  // (unset → NULL → fail-closed)
  return `(${base}) AND current_setting('weavekit.scope_id', true) = ${q(field)}`;
}

function baseRlsPolicy(def: ObjectDefinition): string | undefined {
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

/**
 * Marker stored as the policy COMMENT: a digest of the policy definition, so
 * `migrate` detects a changed predicate (permission matrix edit), not just a
 * missing policy name.
 */
export function rlsPolicyComment(definition: string): string {
  return `weavekit:${createHash('sha256').update(definition).digest('hex').slice(0, 16)}`;
}

/**
 * Object-path RLS (`EngineConfig.rls.enforce`): the engine's own data access
 * runs customer-table reads/updates/deletes under this role, so PostgreSQL
 * re-checks the RBAC row scope (defense in depth). Engine-internal — it never
 * executes user-supplied SQL (that is the restricted-SQL role's job).
 */
export const OBJECT_RLS_ROLE_DEFAULT = 'weavekit_object';

/** per-table object-path policy names (scoped `TO <object role>`) */
export const OBJECT_RLS_POLICIES = {
  SELECT: 'weavekit_obj_select',
  UPDATE: 'weavekit_obj_update',
  DELETE: 'weavekit_obj_delete',
} as const;

export interface ObjectRlsPolicy {
  name: (typeof OBJECT_RLS_POLICIES)[keyof typeof OBJECT_RLS_POLICIES];
  command: 'SELECT' | 'UPDATE' | 'DELETE';
  using: string;
  check?: string;
}

/** a subject GUC as a nullable value ('' — a GUC reset by an earlier transaction — counts as unset) */
const gucValue = (name: string): string => `NULLIF(current_setting('${name}', true), '')`;
const ACTOR_GUC = gucValue('weavekit.actor_id');
const DEPARTMENT_GUC = gucValue('weavekit.department_id');
const SCOPE_GUC = gucValue('weavekit.scope_id');
const SCOPE_TOKEN = '__weavekit_scope__';
/** placeholder subject: its attributes are mapped back onto the GUCs */
const TEMPLATE_SUBJECT = { id: '\u0001actor', roles: [] as string[], departmentId: '\u0001department', scopeId: '\u0001scope' };

/**
 * The application row-scope predicate (`buildRowScopeFor`) for one scope,
 * re-expressed over the subject GUCs — one source of truth for both layers.
 */
function scopeTemplate(lookup: ObjectLookup, def: ObjectDefinition, scope: ReadScope): string | undefined {
  const fragment = buildRowScopeFor(lookup, def, scope, TEMPLATE_SUBJECT, []);
  if (fragment === undefined) return undefined;
  let sql = fragment.sql;
  for (let i = fragment.params.length; i >= 1; i -= 1) {
    const value = fragment.params[i - 1];
    const expr =
      value === TEMPLATE_SUBJECT.id
        ? ACTOR_GUC
        : value === TEMPLATE_SUBJECT.departmentId
          ? DEPARTMENT_GUC
          : value === TEMPLATE_SUBJECT.scopeId
            ? SCOPE_TOKEN
            : undefined;
    if (expr === undefined) throw new Error(`object "${def.name}": unexpected row-scope parameter`);
    sql = sql.replace(new RegExp(`\\$${i}(?!\\d)`, 'g'), expr);
  }
  // a scope-less subject is not bounded by the scope column (mirrors buildRowScope)
  return sql.replace(
    new RegExp(`((?:\\w+\\.)?"[^"]+") = ${SCOPE_TOKEN}`, 'g'),
    `(${SCOPE_GUC} IS NULL OR $1 = ${SCOPE_GUC})`,
  );
}

function rolesOf(lookup: ObjectLookup, def: ObjectDefinition): string[] {
  const parent = def.detailsParent === undefined ? undefined : lookup.get(def.detailsParent);
  return [...new Set([...Object.keys(def.permissions ?? {}), ...Object.keys(parent?.permissions ?? {})])].sort();
}

function orJoin(clauses: string[]): string | undefined {
  const unique = [...new Set(clauses)];
  if (unique.length === 0) return undefined;
  return unique.length === 1 ? unique[0]! : `(${unique.join(' OR ')})`;
}

/**
 * Union over the roles of each role's scope predicate (`roleIn AND scope`).
 * The app resolves multi-role subjects to the most permissive scope, so the
 * union is never narrower than the application layer.
 */
function scopePredicate(
  lookup: ObjectLookup,
  def: ObjectDefinition,
  pick: (p: ResolvedPermission) => Array<ReadScope | undefined>,
): string | undefined {
  // open mode (no permissions bind any role): no role gate
  const open = resolvePermissionFor(lookup, def, ['\u0001probe']);
  if (open !== undefined) {
    return orJoin(pick(open).filter((s): s is ReadScope => s !== undefined).map((s) => scopeTemplate(lookup, def, s) ?? 'true'));
  }
  const clauses: string[] = [];
  for (const role of rolesOf(lookup, def)) {
    const p = resolvePermissionFor(lookup, def, [role]);
    if (p === undefined) continue;
    for (const scope of new Set(pick(p).filter((s): s is ReadScope => s !== undefined))) {
      const template = scopeTemplate(lookup, def, scope);
      clauses.push(template === undefined ? roleIn(role) : `(${roleIn(role)} AND (${template}))`);
    }
  }
  return orJoin(clauses);
}

/**
 * Object-path policies for one object. SELECT covers read ∪ manage (PostgreSQL
 * also applies the SELECT policy to the rows an UPDATE/DELETE reads); UPDATE /
 * DELETE use the manage scope. UPDATE's WITH CHECK only bounds the scope
 * column (the application keeps it immutable). INSERT is not policed here: the
 * engine inserts as the owner and stamps the scope column itself.
 */
export function buildObjectRlsPolicies(lookup: ObjectLookup, def: ObjectDefinition): ObjectRlsPolicy[] {
  const policies: ObjectRlsPolicy[] = [];
  const select = scopePredicate(lookup, def, (p) => [p.read, p.manage]);
  if (select !== undefined) policies.push({ name: OBJECT_RLS_POLICIES.SELECT, command: 'SELECT', using: select });
  const manage = scopePredicate(lookup, def, (p) => [p.manage]);
  if (manage !== undefined) {
    const field = scopeFieldName(def);
    const check = field === undefined ? 'true' : `(${SCOPE_GUC} IS NULL OR ${q(field)} = ${SCOPE_GUC})`;
    policies.push({ name: OBJECT_RLS_POLICIES.UPDATE, command: 'UPDATE', using: manage, check });
    policies.push({ name: OBJECT_RLS_POLICIES.DELETE, command: 'DELETE', using: manage });
  }
  return policies;
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
