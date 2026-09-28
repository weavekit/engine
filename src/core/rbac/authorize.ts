import type { ObjectDefinition } from '../types/index.js';
import type { Locale, MessageKey } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import { resolvePermission, type ResolvedPermission } from './resolve.js';
import { resolvePermissionFor, type ObjectLookup } from './details.js';

function deny(locale: Locale | undefined, code: MessageKey, params: Record<string, unknown>): never {
  throw new SchemaError(code, params, locale);
}

/** resolve a permission, deriving from a details parent when `lookup` is given */
function perm(
  def: ObjectDefinition,
  roles: readonly string[],
  lookup?: ObjectLookup,
): ResolvedPermission | undefined {
  return lookup === undefined ? resolvePermission(def, roles) : resolvePermissionFor(lookup, def, roles);
}

export function canCreate(def: ObjectDefinition, roles: readonly string[], lookup?: ObjectLookup): boolean {
  return perm(def, roles, lookup)?.create === true;
}

export function canDelete(def: ObjectDefinition, roles: readonly string[], lookup?: ObjectLookup): boolean {
  return perm(def, roles, lookup)?.delete === true;
}

export function canUpdate(def: ObjectDefinition, roles: readonly string[], lookup?: ObjectLookup): boolean {
  const p = perm(def, roles, lookup);
  if (p === undefined) return false;
  return p.update === null || p.update.length > 0;
}

export function canUpdateField(
  def: ObjectDefinition,
  roles: readonly string[],
  field: string,
  lookup?: ObjectLookup,
): boolean {
  const p = perm(def, roles, lookup);
  if (p === undefined) return false;
  return p.update === null || p.update.includes(field);
}

/** allowed update fields; null = all fields, [] = none */
export function allowedUpdateFields(
  def: ObjectDefinition,
  roles: readonly string[],
  lookup?: ObjectLookup,
): string[] | null {
  return perm(def, roles, lookup)?.update ?? null;
}

export function assertCanCreate(
  def: ObjectDefinition,
  roles: readonly string[],
  locale?: Locale,
  lookup?: ObjectLookup,
): void {
  if (!canCreate(def, roles, lookup)) deny(locale, 'rbac.denied.create', { object: def.name, role: roles.join(',') });
}

export function assertCanUpdate(
  def: ObjectDefinition,
  roles: readonly string[],
  locale?: Locale,
  lookup?: ObjectLookup,
): void {
  if (!canUpdate(def, roles, lookup)) deny(locale, 'rbac.denied.update', { object: def.name, role: roles.join(',') });
}

export function assertCanDelete(
  def: ObjectDefinition,
  roles: readonly string[],
  locale?: Locale,
  lookup?: ObjectLookup,
): void {
  if (!canDelete(def, roles, lookup)) deny(locale, 'rbac.denied.delete', { object: def.name, role: roles.join(',') });
}

export function assertCanUpdateField(
  def: ObjectDefinition,
  roles: readonly string[],
  field: string,
  locale?: Locale,
  lookup?: ObjectLookup,
): void {
  if (!canUpdateField(def, roles, field, lookup)) {
    deny(locale, 'rbac.denied.field', { object: def.name, role: roles.join(','), field });
  }
}
