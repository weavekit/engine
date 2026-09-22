import type { FieldDefinition, Permissions, ReadScope } from '../../types/index.js';
import { FIELD_TYPES, READ_SCOPES } from '../../types/values.js';
import { fail, isRecord, type Vc } from './primitives.js';

/** validate the permissions map: role -> read/create/update/delete/fields.exclude */
const READ_SCOPE_VALUES: readonly string[] = Object.values(READ_SCOPES);

export function validatePermissions(raw: unknown, vc: Vc, fields: readonly FieldDefinition[]): Permissions | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(vc, 'permission.notObject');
  const result: Permissions = {};
  for (const [role, value] of Object.entries(raw)) {
    if (!isRecord(value)) fail(vc, 'permission.role.notObject', { role });
    if (value.read !== undefined && !READ_SCOPE_VALUES.includes(value.read as string)) {
      fail(vc, 'permission.read.invalid', { role });
    }
    if (value.create !== undefined && typeof value.create !== 'boolean') fail(vc, 'permission.create.boolean', { role });
    if (value.delete !== undefined && typeof value.delete !== 'boolean') fail(vc, 'permission.delete.boolean', { role });
    if (value.update !== undefined) {
      if (typeof value.update !== 'boolean' && (!Array.isArray(value.update) || !value.update.every((f) => typeof f === 'string'))) {
        fail(vc, 'permission.update.invalid', { role });
      }
    }
    if (value.fields !== undefined) {
      if (!isRecord(value.fields)) fail(vc, 'permission.fields.notObject', { role });
      if (value.fields.exclude !== undefined && (!Array.isArray(value.fields.exclude) || !value.fields.exclude.every((f) => typeof f === 'string'))) {
        fail(vc, 'permission.exclude.strings', { role });
      }
      if (value.fields.create !== undefined) {
        if (!Array.isArray(value.fields.create) || !value.fields.create.every((f) => typeof f === 'string')) {
          fail(vc, 'permission.createFields.strings', { role });
        }
        validateCreateFields(role, value.fields.create, fields, vc);
      }
    }
    result[role] = {
      read: value.read as ReadScope | undefined,
      create: value.create as boolean | undefined,
      update: value.update as boolean | string[] | undefined,
      delete: value.delete as boolean | undefined,
      fields: value.fields as { exclude?: string[]; create?: string[] } | undefined,
    };
  }
  return result;
}

/** a create whitelist must name real fields and cover every required writable field */
function validateCreateFields(role: string, create: string[], fields: readonly FieldDefinition[], vc: Vc): void {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const pk = fields.find((f) => f.primary)?.name;
  for (const name of create) {
    if (!byName.has(name)) fail(vc, 'permission.createFields.unknown', { role, field: name });
  }
  for (const field of fields) {
    if (field.primary === true || field.name === pk) continue;
    const required = 'required' in field && field.required === true;
    const readonly = field.system === true || field.type === FIELD_TYPES.SEQ_NO || (field as { formula?: string }).formula !== undefined;
    if (!required || readonly) continue;
    if (!create.includes(field.name)) {
      fail(vc, 'permission.createFields.missingRequired', { role, field: field.name });
    }
  }
}
