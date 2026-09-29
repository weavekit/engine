import type { ObjectDefinition, ReadScope } from '../types/index.js';
import { DETAILS_COLUMNS } from '../types/values.js';
import type { Locale } from '../i18n/index.js';
import type { IdentitySubject } from '../provider/identity/types.js';
import { resolvePermission, type ResolvedPermission } from './resolve.js';
import { buildRowScope, type RowScopeFragment } from './rowScope.js';
import { recordKeySql } from '../storage/record-key-sql.js';

/**
 * Details-child permission inheritance.
 *
 * A `details` child is an owned part of its parent record: its effective
 * permission/scope is derived from the parent. A child may **narrow** (declare
 * stricter permissions) but never broaden — the two are intersected. A child
 * with no declared `permissions` is exactly its parent's.
 */

/** minimal registry lookup (ObjectRegistry structurally satisfies it) — avoids a core cycle */
export interface ObjectLookup {
  get(name: string): ObjectDefinition | undefined;
}

const q = (name: string) => `"${name}"`;
const SCOPE_RANK: Record<ReadScope, number> = { own: 1, department: 2, all: 3 };

/** the narrower of two scopes; undefined (denied) on either side wins */
function narrowerScope(a: ReadScope | undefined, b: ReadScope | undefined): ReadScope | undefined {
  if (a === undefined || b === undefined) return undefined;
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b;
}

/** intersect two allowed-field lists (`null` = all; `[]` = none) */
function intersectAllowed(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  const set = new Set(b);
  return a.filter((field) => set.has(field));
}

/**
 * Effective permission for `def`, deriving from its details parent when it is a
 * child (intersection — never broader). Non-child objects resolve as-is.
 */
export function resolvePermissionFor(
  lookup: ObjectLookup,
  def: ObjectDefinition,
  roles: readonly string[],
): ResolvedPermission | undefined {
  const own = resolvePermission(def, roles);
  const parentName = def.detailsParent;
  if (parentName === undefined) return own;
  const parent = lookup.get(parentName);
  if (parent === undefined) return own;
  const parentPerm = resolvePermission(parent, roles);
  // fail-closed: a denial on either side denies the child
  if (parentPerm === undefined || own === undefined) return undefined;
  return {
    read: narrowerScope(parentPerm.read, own.read),
    manage: narrowerScope(parentPerm.manage, own.manage),
    create: parentPerm.create && own.create,
    update: intersectAllowed(parentPerm.update, own.update),
    delete: parentPerm.delete && own.delete,
    exclude: Array.from(new Set([...parentPerm.exclude, ...own.exclude])),
    createFields: intersectAllowed(parentPerm.createFields, own.createFields),
  };
}

/**
 * Row-scope fragment for `def`. A details child is scoped by membership in its
 * (scoped) parent set: `EXISTS (SELECT 1 FROM parent p WHERE <parent scope> AND
 * p.<record_key> = child.parent_id)`.
 *
 * `alias` qualifies the child-side column references (the child's `parent_id`),
 * for embedding the predicate in a correlated subquery over an aliased target
 * table (e.g. element-level scoping of a `multiRelation` target).
 */
export function buildRowScopeFor(
  lookup: ObjectLookup,
  def: ObjectDefinition,
  scope: ReadScope | undefined,
  subject: IdentitySubject,
  roles: readonly string[],
  locale?: Locale,
  alias?: string,
): RowScopeFragment | undefined {
  const parentName = def.detailsParent;
  if (parentName === undefined) return buildRowScope(def, scope, subject, roles, locale, alias);
  const parent = lookup.get(parentName);
  if (parent === undefined) return buildRowScope(def, scope, subject, roles, locale, alias);
  const parentFragment = buildRowScope(parent, scope, subject, roles, locale, 'p');
  if (parentFragment === undefined) return undefined;
  const rk = recordKeySql(parent, (field) => `p.${q(field)}`);
  const childId = alias === undefined ? q(DETAILS_COLUMNS.PARENT_ID) : `${alias}.${q(DETAILS_COLUMNS.PARENT_ID)}`;
  return {
    sql: `EXISTS (SELECT 1 FROM ${q(parent.name)} p WHERE (${parentFragment.sql}) AND ${rk} = ${childId})`,
    params: parentFragment.params,
  };
}
