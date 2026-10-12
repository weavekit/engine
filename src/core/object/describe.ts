import type { Locale } from '../i18n/index.js';
import { resolvePermissionFor, type ResolvedPermission } from '../rbac/index.js';
import { RECORD_META_VIRTUAL_FIELD_SPECS, type RecordMetaVirtualFieldSpec } from '../storage/record-meta.js';
import { SchemaError } from '../types/errors.js';
import {
  FIELD_TYPES,
  fieldBase,
  isRelationLike,
  primaryKeyOf,
  type FieldDefinition,
  type FieldTypeRegistry,
} from '../types/index.js';
import type {
  MetadataAttrSpec,
  MetadataField,
  MetadataPermissions,
  ObjectDescriptor,
  ObjectListEntry,
} from '@weave-kit/contract';
import type { ObjectRegistry } from './registry.js';

/**
 * Metadata description — the engine's neutral "schema + permissions" view,
 * shared by the MCP introspection tools and the REST metadata/permissions
 * endpoints. Protocol-agnostic: describes type semantics only (enum
 * options, relation targets, multiple), never UI/widget hints — the Headless
 * line stays intact; frontends derive controls from field types.
 */

// metadata descriptor shapes live in @weave-kit/contract (shared with client/console)
export type {
  MetadataAttrSpec,
  MetadataField,
  MetadataRelation,
  MetadataPermissions,
  ObjectDescriptor,
  ObjectListEntry,
} from '@weave-kit/contract';

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

function fieldDescription(field: FieldDefinition, objects: ObjectRegistry): MetadataField {
  const registry = objects.fieldTypes;
  const out: MetadataField = {
    name: field.name,
    type: field.type,
    labels: field.labels,
    description: field.description,
  };
  // the resolved primitive a delegated/registered type inherits (omit when the
  // type is already a primitive) — lets front-ends map any type to a base control
  const base = fieldBase(registry, field.type);
  if (base !== field.type) out.base = base;
  const attrs = attrSpecsOf(field, registry);
  if (attrs !== undefined) out.attrs = attrs;
  const readonly = field.system === true || (field as { formula?: string }).formula !== undefined;
  if (readonly) out.readOnly = true;
  if ('required' in field && field.required === true) out.required = true;
  if (field.primary === true) out.primary = true;
  if (field.type === FIELD_TYPES.ENUM) {
    if (Array.isArray(field.options)) {
      out.options = field.options;
      // a declared named enum: surface the shared type + per-value labels
      const enumType = (field as { enumType?: string }).enumType;
      const declaration = enumType === undefined ? undefined : objects.enums.get(enumType);
      if (declaration !== undefined) {
        out.enum = declaration.name;
        if (declaration.labels !== undefined) out.optionLabels = declaration.labels;
      }
    } else {
      const target = objects.get(field.options.from.object);
      const column = field.options.from.column ?? (target === undefined ? undefined : primaryKeyOf(target));
      out.optionsFrom = { object: field.options.from.object, column: column ?? field.options.from.column ?? '' };
    }
    out.multiple = field.multiple === true;
  }
  if (field.type === FIELD_TYPES.IMAGE) {
    out.multiple = field.multiple === true;
  }
  if (isRelationLike(registry, field.type)) {
    out.target = (field as { target?: string }).target;
    if ((field as { multiple?: boolean }).multiple === true) out.multiple = true;
  }
  if (field.type === FIELD_TYPES.USER) {
    // the identity object's department FK column (surfaced for the resolve layer)
    out.department = 'department_id';
  }
  if (field.type === FIELD_TYPES.CURRENCY) {
    const code = (field as { currency?: string }).currency;
    if (code !== undefined) out.currency = code;
  }
  // row-scope markers: which column backs `own` / `department`, and its id source
  const scope = field as unknown as { ownership?: boolean; department?: boolean; ownershipSource?: string; departmentSource?: string };
  if (scope.ownership === true) {
    out.ownership = true;
    out.scopeSource = scope.ownershipSource === 'external' ? 'external' : 'internal';
  }
  if (scope.department === true) {
    out.departmentScope = true;
    out.scopeSource = scope.departmentSource === 'external' ? 'external' : 'internal';
  }
  return out;
}

/** descriptive entry for one virtual system field (`weave_*`), marked virtual + read-only */
function virtualFieldDescription(spec: RecordMetaVirtualFieldSpec): MetadataField {
  const out: MetadataField = { name: spec.name, type: spec.type, virtual: true, readOnly: true };
  if (spec.options !== undefined) out.options = [...spec.options];
  if (spec.multiple === true) out.multiple = true;
  return out;
}

function permissionsOf(perm: ResolvedPermission): MetadataPermissions {
  return {
    read: perm.read,
    manage: perm.manage,
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
    .filter((def) => resolvePermissionFor(registry, def, roles)?.read !== undefined)
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
  const perm = resolvePermissionFor(registry, def, roles);
  if (perm === undefined || perm.read === undefined) {
    throw new SchemaError('rbac.denied.read', { object: name, role: roles.join(',') }, locale);
  }
  const excluded = new Set(perm.exclude);
  const fieldTypes = registry.fieldTypes;
  const fields = def.fields.filter((f) => !excluded.has(f.name)).map((f) => fieldDescription(f, registry));
  // virtual system fields are engine-managed; expose them (read-only) so clients
  // and agents know `weave_id` and the metadata fields, and can request them
  const virtual = RECORD_META_VIRTUAL_FIELD_SPECS
    .filter((s) => !excluded.has(s.name))
    .map(virtualFieldDescription);
  const relations = def.fields
    .filter((f) => isRelationLike(fieldTypes, f.type))
    .map((f) => ({ field: f.name, type: f.type, target: (f as { target?: string }).target }));
  return {
    name: def.name,
    labels: def.labels,
    description: def.description,
    titleTemplate: def.titleTemplate,
    fields: [...fields, ...virtual],
    relations,
    permissions: permissionsOf(perm),
    ...(def.workflowEnabled === undefined ? {} : { workflowEnabled: def.workflowEnabled }),
    ...(def.workflow === undefined ? {} : { workflow: def.workflow }),
    ...(def.workflowHash === undefined ? {} : { workflowHash: def.workflowHash }),
  };
}

/** per-object effective permissions for the identity (any resolved permission — read, create, update or delete) */
export function listObjectPermissions(
  registry: ObjectRegistry,
  roles: readonly string[],
): Array<{ name: string; labels?: Record<string, string>; permissions: MetadataPermissions }> {
  const out: Array<{ name: string; labels?: Record<string, string>; permissions: MetadataPermissions }> = [];
  for (const def of registry.list()) {
    const perm = resolvePermissionFor(registry, def, roles);
    if (perm !== undefined) {
      out.push({ name: def.name, labels: def.labels, permissions: permissionsOf(perm) });
    }
  }
  return out;
}
