import type { ObjectDefinition, PermissionDefinition, ReadScope } from '../types/index.js';
import { READ_SCOPES } from '../types/index.js';

/** the effective permission for a set of roles, after applying defaults and merging */
export interface ResolvedPermission {
  /** read scope; undefined = read denied */
  read?: ReadScope;
  create: boolean;
  /** null = all fields updatable; [] = none; otherwise the whitelist */
  update: string[] | null;
  delete: boolean;
  /** fields hidden from read output for these roles */
  exclude: string[];
  /** null = all writable fields allowed on create; [] = none; otherwise the whitelist */
  createFields: string[] | null;
}

const READ_RANK: Record<ReadScope, number> = { own: 1, team: 2, all: 3 };

/** defaults for a declared role: unspecified operations are denied (fail-closed) */
function declaredPermission(p: PermissionDefinition): ResolvedPermission {
  return {
    read: p.read,
    create: p.create ?? false,
    // update: true -> null (all fields updatable); false/undefined -> [] (none)
    update: p.update === true ? null : (typeof p.update === 'boolean' ? [] : (p.update ?? [])),
    delete: p.delete ?? false,
    exclude: p.fields?.exclude ?? [],
    // fields.create: undefined -> null (unrestricted, backward compatible); [] -> none; else whitelist
    createFields: p.fields?.create === undefined ? null : p.fields.create,
  };
}

/**
 * Resolve the effective permission for a subject's roles.
 * - no `permissions` map on the object → full CRUD (open mode)
 * - permissions declared but none of the roles listed → denied (returns undefined)
 * - multiple roles → merged: read takes the most permissive scope, update/exclude union
 */
export function resolvePermission(
  def: ObjectDefinition,
  roles: readonly string[],
): ResolvedPermission | undefined {
  if (def.permissions === undefined) {
    return { read: READ_SCOPES.ALL, create: true, update: null, delete: true, exclude: [], createFields: null };
  }
  const resolved: ResolvedPermission[] = [];
  for (const role of roles) {
    const p = def.permissions[role];
    if (p !== undefined) resolved.push(declaredPermission(p));
  }
  if (resolved.length === 0) return undefined;

  let read: ReadScope | undefined;
  for (const r of resolved) {
    if (r.read !== undefined && (read === undefined || READ_RANK[r.read] > READ_RANK[read])) {
      read = r.read;
    }
  }
  const update: string[] | null = resolved.some((r) => r.update === null)
    ? null
    : Array.from(new Set(resolved.flatMap((r) => r.update ?? [])));
  const createFields: string[] | null = resolved.some((r) => r.createFields === null)
    ? null
    : Array.from(new Set(resolved.flatMap((r) => r.createFields ?? [])));
  return {
    read,
    create: resolved.some((r) => r.create),
    delete: resolved.some((r) => r.delete),
    update,
    exclude: Array.from(new Set(resolved.flatMap((r) => r.exclude))),
    createFields,
  };
}
