import type { ObjectDefinition } from '../types/index.js';
import { READ_SCOPES, ROW_SCOPE_MARKERS } from '../types/index.js';
import type { RowScopeMarker } from '../types/index.js';

const q = (id: string) => `"${id}"`;

/**
 * Row-level security policy generation for the script sandbox's restricted SQL
 * (`this.db.query`). The engine's own data access runs as the table owner, which
 * bypasses RLS (no `FORCE`), so row scoping stays in the application layer there.
 * `db.query` switches to a dedicated non-owner role (`SET LOCAL ROLE`) that IS
 * subject to RLS, and the subject is carried in session GUCs:
 *
 * - `weavekit.roles`     comma-joined role names
 * - `weavekit.actor_id`  subject id (own scope)
 * - `weavekit.team_id`   subject team id (team scope)
 *
 * Unset GUCs resolve to NULL → the predicate is false → **0 rows (fail-closed)**.
 *
 * The predicate mirrors `resolvePermission` + `buildRowScope`: this is a second
 * encoding of the same matrix, so a parity test (db.objects vs db.query must
 * return the same rows for the same subject) guards against drift.
 */

const POLICY_PREFIX = 'weavekit_read_';

export function policyName(def: ObjectDefinition): string {
  return `${POLICY_PREFIX}${def.name}`;
}

function roleIn(role: string): string {
  return `'${role.replace(/'/g, "''")}' = ANY (string_to_array(current_setting('weavekit.roles', true), ','))`;
}

function markerField(def: ObjectDefinition, marker: RowScopeMarker): string | undefined {
  return def.fields.find((f) => (f as unknown as Record<string, boolean>)[marker as unknown as string] === true)?.name;
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
    } else if (p.read === READ_SCOPES.TEAM) {
      const field = markerField(def, ROW_SCOPE_MARKERS.TEAM);
      if (field !== undefined) {
        clauses.push(`(${roleIn(role)} AND current_setting('weavekit.team_id', true) = ${q(field)})`);
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
  return `GRANT SELECT ON ${q(def.name)} TO ${role};`;
}
