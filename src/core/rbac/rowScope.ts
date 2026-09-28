import type { ObjectDefinition, ReadScope, RowScopeMarker, ScopeSource } from '../types/index.js';
import { READ_SCOPES, ROW_SCOPE_MARKERS, SCOPE_SOURCES } from '../types/index.js';
import type { Locale } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import type { IdentitySubject } from '../provider/identity/types.js';

export interface RowScopeFragment {
  sql: string;
  params: unknown[];
}

const q = (name: string) => `"${name}"`;

/** qualify a column when a table alias is in play (`p."owner_id"`), else bare */
const col = (alias: string | undefined, name: string): string =>
  alias === undefined ? q(name) : `${alias}.${q(name)}`;

/** a scope-marked field (ownership / department) on an object, with its value source */
interface ScopeField {
  name: string;
  source: ScopeSource;
}

function markerField(def: ObjectDefinition, marker: RowScopeMarker): ScopeField | undefined {
  const field = def.fields.find((f) => (f as unknown as Record<string, boolean>)[marker] === true);
  if (field === undefined) return undefined;
  const raw = field as unknown as Record<string, unknown>;
  const source = raw[`${marker}Source`];
  return {
    name: field.name,
    source: source === SCOPE_SOURCES.EXTERNAL ? SCOPE_SOURCES.EXTERNAL : SCOPE_SOURCES.INTERNAL,
  };
}

/** record internal uuids of the department subtree rooted at `$1` (a subject's department) */
function departmentSubtreeSql(): string {
  return `(WITH RECURSIVE sub AS (
    SELECT id::text AS id FROM weavekit_department WHERE id::text = $1
    UNION ALL
    SELECT d.id::text FROM weavekit_department d JOIN sub s ON d.parent_id::text = s.id
  ) SELECT id FROM sub)`;
}

/** own scope: the record's ownership column identifies the subject */
function ownFragment(ownership: ScopeField, alias?: string): RowScopeFragment {
  if (ownership.source === SCOPE_SOURCES.EXTERNAL) {
    // ownership holds external user ids → translate the subject's internal id
    return {
      sql: `${col(alias, ownership.name)} IN (SELECT external_id FROM weavekit_user WHERE id::text = $1)`,
      params: [],
    };
  }
  return { sql: `${col(alias, ownership.name)} = $1`, params: [] };
}

/** department scope via a record-owned department column (mode B) */
function departmentColumnFragment(dept: ScopeField, alias?: string): RowScopeFragment {
  if (dept.source === SCOPE_SOURCES.EXTERNAL) {
    return {
      sql: `(${col(alias, dept.name)} IN (SELECT external_id FROM weavekit_department WHERE id::text = $1)
        OR ${col(alias, dept.name)} IN (SELECT external_id FROM weavekit_department WHERE id::text IN ${departmentSubtreeSql()}))`,
      params: [],
    };
  }
  return { sql: `(${col(alias, dept.name)} = $1 OR ${col(alias, dept.name)} IN ${departmentSubtreeSql()})`, params: [] };
}

/** department scope derived from the record's owner (mode A): owner → user → department */
function departmentByOwnerFragment(ownership: ScopeField, alias?: string): RowScopeFragment {
  const userMatch = ownership.source === SCOPE_SOURCES.EXTERNAL
    ? `u.external_id = ${col(alias, ownership.name)}`
    : `u.id::text = ${col(alias, ownership.name)}`;
  return {
    sql: `EXISTS (SELECT 1 FROM weavekit_user u WHERE ${userMatch}
      AND (u.department_id::text = $1 OR u.department_id::text IN ${departmentSubtreeSql()}))`,
    params: [],
  };
}

/**
 * Build the row-level WHERE fragment for a scope (`read` or `manage`):
 * - `all` → undefined (no restriction)
 * - `own` → the record's ownership column identifies the subject
 * - `department` → the record's department (a declared `department` column, or
 *   derived from its owner's `weavekit_user.department_id`) is the subject's
 *   department or a descendant (recursive over `weavekit_department`)
 *
 * The fragment uses `$1` for the subject attribute; `builder.scopeSuffix`
 * renumbers it against the surrounding query. `alias` qualifies the scope
 * column references against a table alias (used when embedding the predicate in
 * a correlated subquery, e.g. a details child scoped by its parent).
 */
export function buildRowScope(
  def: ObjectDefinition,
  scope: ReadScope | undefined,
  subject: IdentitySubject,
  roles: readonly string[],
  locale?: Locale,
  alias?: string,
): RowScopeFragment | undefined {
  if (scope === undefined || scope === READ_SCOPES.ALL) return undefined;
  const role = roles.join(',');

  const ownership = markerField(def, ROW_SCOPE_MARKERS.OWNERSHIP);

  if (scope === READ_SCOPES.OWN) {
    if (ownership === undefined) {
      throw new SchemaError('rbac.scope.columnMissing', { object: def.name, role, scope }, locale);
    }
    const fragment = ownFragment(ownership, alias);
    return { sql: fragment.sql, params: [subject.id] };
  }

  if (scope === READ_SCOPES.DEPARTMENT) {
    if (subject.departmentId === undefined) {
      throw new SchemaError('rbac.departmentId.missing', { object: def.name }, locale);
    }
    const dept = markerField(def, ROW_SCOPE_MARKERS.DEPARTMENT);
    if (dept !== undefined) {
      const fragment = departmentColumnFragment(dept, alias);
      return { sql: fragment.sql, params: [subject.departmentId] };
    }
    if (ownership !== undefined) {
      const fragment = departmentByOwnerFragment(ownership, alias);
      return { sql: fragment.sql, params: [subject.departmentId] };
    }
    throw new SchemaError('rbac.scope.columnMissing', { object: def.name, role, scope }, locale);
  }

  return undefined;
}
