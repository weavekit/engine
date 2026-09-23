import type { Locale } from '../i18n/index.js';
import { resolvePermission, type ResolvedPermission } from '../rbac/index.js';
import { SchemaError } from '../types/errors.js';
import {
  FIELD_TYPES,
  isRelationLike,
  type AttrKind,
  type FieldDefinition,
  type FieldTypeRegistry,
  type ReadScope,
} from '../types/index.js';
import type { ObjectRegistry } from './registry.js';

/**
 * Metadata description — the engine's neutral "schema + permissions" view,
 * shared by the MCP introspection tools and the REST metadata/permissions
 * endpoints (M11). Protocol-agnostic: describes type semantics only (enum
 * options, relation targets, multiple), never UI/widget hints — the Headless
 * line stays intact; frontends derive controls from field types.
 */

/** one declared extra attribute of a registered-type field: its value (when set) plus its spec */
export interface MetadataAttrSpec {
  /** this field's declared value (absent when the attr is optional and not set) */
  value?: unknown;
  /** the attr's value kind (from the type's `AttrSpec`) */
  type: AttrKind;
  /** allowed values (enum only) */
  values?: string[];
  /** spec default (documentation; not injected into the field) */
  default?: unknown;
  /** human description (data semantics, never a widget) */
  description?: string;
}

/** one field as seen by a frontend — type semantics only */
export interface MetadataField {
  name: string;
  type: string;
  /** per-locale display names; resolve with `resolveLabel` (absent → use `name`) */
  labels?: Record<string, string>;
  description?: string;
  required?: boolean;
  options?: string[];
  multiple?: boolean;
  target?: string;
  /** for `person` fields: the department FK field name on the person target object */
  department?: string;
  /** true when this field is the object's primary key (the CRUD id field for frontends) */
  primary?: boolean;
  /** true for engine-managed read-only fields (system / formula); `seq_no` is derivable from its type */
  readOnly?: boolean;
  /**
   * declared extra attributes of a registered-type field, each paired with its
   * type's `AttrSpec` (kind/values/default/description). Only attributes the
   * registration declares are exposed — never storage/validation/UI internals.
   */
  attrs?: Record<string, MetadataAttrSpec>;
}

/** a relation field (weak/strong/multi) as a named edge */
export interface MetadataRelation {
  field: string;
  type: string;
  target?: string;
}

/** effective permissions for one identity on one object */
export interface MetadataPermissions {
  read?: ReadScope;
  create: boolean;
  /** null = every field updatable; [] = none; otherwise the field whitelist */
  update: string[] | null;
  delete: boolean;
  /** fields hidden from read output for this identity */
  excludedFields: string[];
  /** null = all writable fields allowed on create; [] = none; otherwise the whitelist */
  createFields: string[] | null;
}

/** full object descriptor: schema + the identity's effective permissions */
export interface ObjectDescriptor {
  name: string;
  /** per-locale display names; resolve with `resolveLabel` (absent → use `name`) */
  labels?: Record<string, string>;
  description?: string;
  titleTemplate?: string;
  fields: MetadataField[];
  relations: MetadataRelation[];
  permissions: MetadataPermissions;
}

/** minimal list entry (object name/labels/description) */
export interface ObjectListEntry {
  name: string;
  labels?: Record<string, string>;
  description?: string;
}

/** declared extra attributes of a registered-type field, paired with their `AttrSpec` */
function attrSpecsOf(field: FieldDefinition, registry: FieldTypeRegistry): Record<string, MetadataAttrSpec> | undefined {
  const declared = registry.get(field.type)?.attrs;
  if (declared === undefined) return undefined;
  const record = field as unknown as Record<string, unknown>;
  const out: Record<string, MetadataAttrSpec> = {};
  for (const [name, spec] of Object.entries(declared)) {
    const value = record[name];
    out[name] = {
      ...(value === undefined ? {} : { value }),
      type: spec.type,
      ...(spec.values === undefined ? {} : { values: [...spec.values] }),
      ...(spec.default === undefined ? {} : { default: spec.default }),
      ...(spec.description === undefined ? {} : { description: spec.description }),
    };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function fieldDescription(field: FieldDefinition, registry: FieldTypeRegistry): MetadataField {
  const out: MetadataField = {
    name: field.name,
    type: field.type,
    labels: field.labels,
    description: field.description,
  };
  const attrs = attrSpecsOf(field, registry);
  if (attrs !== undefined) out.attrs = attrs;
  const readonly = field.system === true || (field as { formula?: string }).formula !== undefined;
  if (readonly) out.readOnly = true;
  if ('required' in field && field.required === true) out.required = true;
  if (field.primary === true) out.primary = true;
  if (field.type === FIELD_TYPES.ENUM) {
    out.options = field.options;
    out.multiple = field.multiple === true;
  }
  if (field.type === FIELD_TYPES.IMAGE) {
    out.multiple = field.multiple === true;
  }
  if (isRelationLike(registry, field.type)) {
    out.target = (field as { target?: string }).target;
    if ((field as { multiple?: boolean }).multiple === true) out.multiple = true;
  }
  if (field.type === FIELD_TYPES.PERSON && field.department !== undefined) {
    out.department = field.department;
  }
  return out;
}

function permissionsOf(perm: ResolvedPermission): MetadataPermissions {
  return {
    read: perm.read,
    create: perm.create,
    update: perm.update,
    delete: perm.delete,
    excludedFields: perm.exclude,
    createFields: perm.createFields,
  };
}

/** objects the identity can read — the frontend menu/list minimum (mirrors MCP list_objects) */
export function listObjectDescriptors(registry: ObjectRegistry, roles: readonly string[]): ObjectListEntry[] {
  return registry
    .list()
    .filter((def) => resolvePermission(def, roles)?.read !== undefined)
    .map((def) => ({ name: def.name, labels: def.labels, description: def.description }));
}

/**
 * Full descriptor for one object (schema + effective permissions, excluded
 * fields stripped). Throws `data.objectUnknown` (unknown object) or
 * `rbac.denied.read` (identity may not read it).
 */
export function describeObject(
  registry: ObjectRegistry,
  name: string,
  roles: readonly string[],
  locale: Locale,
): ObjectDescriptor {
  const def = registry.get(name);
  if (def === undefined) throw new SchemaError('data.objectUnknown', { object: name }, locale);
  const perm = resolvePermission(def, roles);
  if (perm === undefined || perm.read === undefined) {
    throw new SchemaError('rbac.denied.read', { object: name, role: roles.join(',') }, locale);
  }
  const excluded = new Set(perm.exclude);
  const fieldTypes = registry.fieldTypes;
  const fields = def.fields.filter((f) => !excluded.has(f.name)).map((f) => fieldDescription(f, fieldTypes));
  const relations = def.fields
    .filter((f) => isRelationLike(fieldTypes, f.type))
    .map((f) => ({ field: f.name, type: f.type, target: (f as { target?: string }).target }));
  return {
    name: def.name,
    labels: def.labels,
    description: def.description,
    titleTemplate: def.titleTemplate,
    fields,
    relations,
    permissions: permissionsOf(perm),
  };
}

/** per-object effective permissions for the identity (any resolved permission — read, create, update or delete) */
export function listObjectPermissions(
  registry: ObjectRegistry,
  roles: readonly string[],
): Array<{ name: string; labels?: Record<string, string>; permissions: MetadataPermissions }> {
  const out: Array<{ name: string; labels?: Record<string, string>; permissions: MetadataPermissions }> = [];
  for (const def of registry.list()) {
    const perm = resolvePermission(def, roles);
    if (perm !== undefined) {
      out.push({ name: def.name, labels: def.labels, permissions: permissionsOf(perm) });
    }
  }
  return out;
}
