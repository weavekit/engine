import type { ObjectDefinition } from '../types/index.js';
import type { Locale, MessageKey } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import { resolvePermission } from './resolve.js';

function deny(locale: Locale | undefined, code: MessageKey, params: Record<string, unknown>): never {
  throw new SchemaError(code, params, locale);
}

export function canCreate(def: ObjectDefinition, roles: readonly string[]): boolean {
  return resolvePermission(def, roles)?.create === true;
}

export function canDelete(def: ObjectDefinition, roles: readonly string[]): boolean {
  return resolvePermission(def, roles)?.delete === true;
}

export function canUpdate(def: ObjectDefinition, roles: readonly string[]): boolean {
  const p = resolvePermission(def, roles);
  if (p === undefined) return false;
  return p.update === null || p.update.length > 0;
}

export function canUpdateField(def: ObjectDefinition, roles: readonly string[], field: string): boolean {
  const p = resolvePermission(def, roles);
  if (p === undefined) return false;
  return p.update === null || p.update.includes(field);
}

/** allowed update fields; null = all fields, [] = none */
export function allowedUpdateFields(def: ObjectDefinition, roles: readonly string[]): string[] | null {
  return resolvePermission(def, roles)?.update ?? null;
}

export function assertCanCreate(
  def: ObjectDefinition,
  roles: readonly string[],
  locale?: Locale,
): void {
  if (!canCreate(def, roles)) deny(locale, 'rbac.denied.create', { object: def.name, role: roles.join(',') });
}

export function assertCanUpdate(
  def: ObjectDefinition,
  roles: readonly string[],
  locale?: Locale,
): void {
  if (!canUpdate(def, roles)) deny(locale, 'rbac.denied.update', { object: def.name, role: roles.join(',') });
}

export function assertCanDelete(
  def: ObjectDefinition,
  roles: readonly string[],
  locale?: Locale,
): void {
  if (!canDelete(def, roles)) deny(locale, 'rbac.denied.delete', { object: def.name, role: roles.join(',') });
}

export function assertCanUpdateField(
  def: ObjectDefinition,
  roles: readonly string[],
  field: string,
  locale?: Locale,
): void {
  if (!canUpdateField(def, roles, field)) {
    deny(locale, 'rbac.denied.field', { object: def.name, role: roles.join(','), field });
  }
}
