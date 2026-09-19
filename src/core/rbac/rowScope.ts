import type { ObjectDefinition, ReadScope, RowScopeMarker } from '../types/index.js';
import { READ_SCOPES, ROW_SCOPE_MARKERS } from '../types/index.js';
import type { Locale } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import type { RbacSubject } from './types.js';

export interface RowScopeFragment {
  sql: string;
  params: unknown[];
}

function ownershipField(def: ObjectDefinition, role: string, locale: Locale | undefined, marker: RowScopeMarker): string {
  const field = def.fields.find((f) => (f as unknown as Record<string, boolean>)[marker] === true);
  if (field === undefined) {
    throw new SchemaError('rbac.denied.read', { object: def.name, role }, locale);
  }
  return field.name;
}

/**
 * Build the row-level WHERE fragment for a read scope.
 * - all → undefined (no restriction)
 * - own → `"<ownershipField>" = :subject.id`
 * - team → `"<teamField>" = :subject.teamId` (throws if the subject has no teamId)
 */
export function buildRowScope(
  def: ObjectDefinition,
  read: ReadScope | undefined,
  subject: RbacSubject,
  roles: readonly string[],
  locale?: Locale,
): RowScopeFragment | undefined {
  if (read === undefined || read === READ_SCOPES.ALL) return undefined;
  const role = roles.join(',');
  if (read === READ_SCOPES.OWN) {
    return { sql: `"${ownershipField(def, role, locale, ROW_SCOPE_MARKERS.OWNERSHIP)}" = $1`, params: [subject.id] };
  }
  if (subject.teamId === undefined) {
    throw new SchemaError('rbac.teamId.missing', { object: def.name }, locale);
  }
  return { sql: `"${ownershipField(def, role, locale, ROW_SCOPE_MARKERS.TEAM)}" = $1`, params: [subject.teamId] };
}
