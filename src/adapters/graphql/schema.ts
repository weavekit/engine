import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  printSchema,
  type GraphQLEnumValueConfigMap,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLScalarType,
} from 'graphql';
import {
  FIELD_TYPES,
  fieldBase,
  isRelationLike,
  RECORD_META_ID_FIELD,
  type EnumField,
  type FieldDefinition,
  type FieldTypeRegistry,
  type ObjectDefinition,
  type ObjectRegistry,
} from '../../core/index.js';
import { GraphQLJSON } from './scalars.js';
import {
  createResolver,
  deleteResolver,
  detailsResolver,
  listResolver,
  multiRelationResolver,
  relationResolver,
  singleResolver,
  transitionResolver,
  updateResolver,
} from './resolvers.js';
import type { GraphQLContext } from './types.js';

/**
 * Compile the object registry into a GraphQL schema.
 *
 * Phase 1: scalar fields + read-only Query. Phase 2: Mutations
 * (`create`/`update`/`delete`, plus `transition` for objects with a workflow).
 * Relations (`relation`/`details`/`multiRelation`) as output fields and nested
 * loaders land in Phase 3.
 *
 * The schema is **identity-agnostic** (built once from the registry): RBAC is
 * enforced at resolve time by the RBAC-decorated data-access layer, so a denied
 * write raises a `rbac.denied.*` GraphQL error and a write is audited exactly as
 * REST/MCP. Build is programmatic so `printSchema` can emit SDL.
 */

const SORT_DIR = { ASC: 'asc', DESC: 'desc' } as const;

/** snake_case → PascalCase (`lead` → `Lead`, `crm_lead` → `CrmLead`) */
function pascalCase(snake: string): string {
  return snake
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** engine-managed read-only fields (never writable): system, computed, sequence */
function isReadonlyField(field: FieldDefinition): boolean {
  return (
    field.system === true ||
    (field as { formula?: string }).formula !== undefined ||
    field.type === FIELD_TYPES.SEQ_NO
  );
}

/** a GraphQL-legal, unique enum value name for an arbitrary stored value */
function enumValueName(raw: string, used: Set<string>): string {
  let name = raw.replace(/[^_0-9A-Za-z]/g, '_');
  if (!/^[_A-Za-z]/.test(name)) name = `_${name}`;
  if (name.length === 0) name = '_';
  let candidate = name;
  let i = 1;
  while (used.has(candidate)) candidate = `${name}_${i++}`;
  used.add(candidate);
  return candidate;
}

/** the GraphQL enum type for a static enum field (data-driven enums are strings) */
function enumTypeFor(field: EnumField, objectName: string, cache: Map<string, GraphQLEnumType>): GraphQLOutputType {
  if (!Array.isArray(field.options)) return GraphQLString;
  const typeName = pascalCase(field.enumType ?? `${objectName}_${field.name}`);
  const cacheKey = `${typeName}::${field.options.join('\u0001')}`;
  let type = cache.get(cacheKey);
  if (type === undefined) {
    const used = new Set<string>();
    const values: GraphQLEnumValueConfigMap = {};
    for (const value of field.options) values[enumValueName(value, used)] = { value };
    type = new GraphQLEnumType({ name: typeName, values });
    cache.set(cacheKey, type);
  }
  return field.multiple === true ? new GraphQLList(type) : type;
}

/** GraphQL output type for one field, or undefined when it is not yet exposed (relations) */
function fieldType(
  field: FieldDefinition,
  registry: FieldTypeRegistry,
  objectName: string,
  cache: Map<string, GraphQLEnumType>,
): GraphQLOutputType | undefined {
  if (isRelationLike(registry, field.type)) return undefined; // Phase 3 (output relations)
  switch (fieldBase(registry, field.type)) {
    case FIELD_TYPES.SMALLINT:
    case FIELD_TYPES.INTEGER:
      return GraphQLInt;
    case FIELD_TYPES.BIGINT:
      return GraphQLString; // precision-safe (pg returns int8 as text)
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
    case FIELD_TYPES.REAL:
    case FIELD_TYPES.DOUBLE:
      return GraphQLFloat;
    case FIELD_TYPES.BOOLEAN:
      return GraphQLBoolean;
    case FIELD_TYPES.JSON:
    case FIELD_TYPES.JSONB:
      return GraphQLJSON;
    case FIELD_TYPES.ENUM:
      return enumTypeFor(field as EnumField, objectName, cache);
    default:
      return GraphQLString;
  }
}

/** the GraphQL scalar for a relation target's primary key (fallback: String) */
function pkType(target: string | undefined, registry: FieldTypeRegistry, objects: ObjectRegistry): GraphQLScalarType {
  const pk = target === undefined ? undefined : objects.get(target)?.fields.find((f) => f.primary === true);
  if (pk === undefined) return GraphQLString;
  switch (fieldBase(registry, pk.type)) {
    case FIELD_TYPES.SMALLINT:
    case FIELD_TYPES.INTEGER:
      return GraphQLInt;
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
    case FIELD_TYPES.REAL:
    case FIELD_TYPES.DOUBLE:
      return GraphQLFloat;
    case FIELD_TYPES.BOOLEAN:
      return GraphQLBoolean;
    default:
      return GraphQLString;
  }
}

/** the GraphQL input type for one writable field, or undefined when it is not writable */
function inputFieldType(
  field: FieldDefinition,
  registry: FieldTypeRegistry,
  objectName: string,
  objects: ObjectRegistry,
  cache: Map<string, GraphQLEnumType>,
): GraphQLInputType | undefined {
  if (field.type === FIELD_TYPES.DETAILS || isReadonlyField(field)) return undefined;
  if (isRelationLike(registry, field.type)) {
    if (field.type === FIELD_TYPES.MULTI_RELATION) return new GraphQLList(GraphQLID); // record keys
    return pkType((field as { target?: string }).target, registry, objects);
  }
  return fieldType(field, registry, objectName, cache) as GraphQLInputType | undefined;
}

/** the GraphQL field for a relation-like schema field, or undefined when it cannot be typed */
function relationField(
  field: FieldDefinition,
  objects: ObjectRegistry,
  objectTypes: Map<string, GraphQLObjectType>,
): GraphQLFieldConfig<unknown, GraphQLContext> | undefined {
  const target = (field as { target?: string }).target;
  const targetType = target === undefined ? undefined : objectTypes.get(target);

  if (field.type === FIELD_TYPES.DETAILS) {
    if (target === undefined || targetType === undefined) return undefined;
    return {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(targetType))),
      resolve: detailsResolver(target),
    };
  }
  if (field.type === FIELD_TYPES.MULTI_RELATION) {
    if (target === undefined || targetType === undefined) return undefined;
    const targetDef = objects.get(target) as ObjectDefinition;
    return {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(targetType))),
      resolve: multiRelationResolver(target, targetDef, field.name),
    };
  }
  // relation / user / department
  if (target !== undefined && targetType !== undefined) {
    return { type: targetType, resolve: relationResolver(target, field.name) };
  }
  // unmodeled target (implicit identity FK) → the raw id as a string
  return { type: GraphQLString, ...(field.description === undefined ? {} : { description: field.description }) };
}

/** the fields of one object type (scalars/enums/json + relations) + read-only `weave_id` */
function objectFields(
  def: { name: string; fields: FieldDefinition[] },
  fieldTypes: FieldTypeRegistry,
  objects: ObjectRegistry,
  objectTypes: Map<string, GraphQLObjectType>,
  cache: Map<string, GraphQLEnumType>,
): GraphQLFieldConfigMap<unknown, GraphQLContext> {
  const fields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {
    [RECORD_META_ID_FIELD]: {
      type: new GraphQLNonNull(GraphQLID),
      description: 'The record id (its `record_key`).',
    },
  };
  for (const field of def.fields) {
    if (isRelationLike(fieldTypes, field.type)) {
      const rel = relationField(field, objects, objectTypes);
      if (rel !== undefined) fields[field.name] = rel;
      continue;
    }
    const type = fieldType(field, fieldTypes, def.name, cache);
    if (type === undefined) continue;
    fields[field.name] = { type, ...(field.description === undefined ? {} : { description: field.description }) };
  }
  return fields;
}

/** the `create`/`update` input object type for one object; undefined when it has no writable fields */
function inputType(
  kind: 'Create' | 'Update',
  def: { name: string; fields: FieldDefinition[] },
  registry: FieldTypeRegistry,
  objects: ObjectRegistry,
  cache: Map<string, GraphQLEnumType>,
): GraphQLInputObjectType | undefined {
  const fields: GraphQLInputFieldConfigMap = {};
  for (const field of def.fields) {
    if (kind === 'Update' && field.primary === true) continue; // primary keys are immutable
    const type = inputFieldType(field, registry, def.name, objects, cache);
    if (type === undefined) continue;
    const required =
      kind === 'Create' &&
      (field as { required?: boolean }).required === true &&
      (field as { default?: unknown }).default === undefined;
    fields[field.name] = { type: required ? new GraphQLNonNull(type) : type };
  }
  if (Object.keys(fields).length === 0) return undefined; // GraphQL input types need ≥1 field
  return new GraphQLInputObjectType({ name: `${pascalCase(def.name)}${kind}Input`, fields });
}

/** compile the registry into a GraphQL schema (only the registry is needed; no data-access) */
export function buildGraphQLSchema(input: { registry: ObjectRegistry }): GraphQLSchema {
  const registry = input.registry;
  const fieldTypes = registry.fieldTypes;
  const enumCache = new Map<string, GraphQLEnumType>();
  const objectTypes = new Map<string, GraphQLObjectType>();

  for (const def of registry.list()) {
    objectTypes.set(
      def.name,
      new GraphQLObjectType({
        name: pascalCase(def.name),
        ...(def.description === undefined ? {} : { description: def.description }),
        fields: () => objectFields(def, fieldTypes, registry, objectTypes, enumCache),
      }),
    );
  }

  const sortDir = new GraphQLEnumType({
    name: 'SortDir',
    values: { [SORT_DIR.ASC]: { value: SORT_DIR.ASC }, [SORT_DIR.DESC]: { value: SORT_DIR.DESC } },
  });
  const sortInput = new GraphQLInputObjectType({
    name: 'SortInput',
    fields: {
      field: { type: new GraphQLNonNull(GraphQLString) },
      dir: { type: new GraphQLNonNull(sortDir) },
    },
  });

  const queryFields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {};
  const mutationFields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {};
  const extraTypes: GraphQLInputObjectType[] = [sortInput];

  for (const def of registry.list()) {
    const objectType = objectTypes.get(def.name) as GraphQLObjectType;
    const typeName = pascalCase(def.name);

    queryFields[def.name] = {
      type: new GraphQLNonNull(
        new GraphQLObjectType({
          name: `${typeName}Page`,
          fields: {
            rows: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))) },
            total: { type: new GraphQLNonNull(GraphQLInt) },
          },
        }),
      ),
      description: `List \`${def.name}\` records (row-scoped by RBAC).`,
      args: {
        filter: { type: GraphQLJSON, description: 'filter by exact values / operators; top-level `$or` groups' },
        sort: { type: new GraphQLList(new GraphQLNonNull(sortInput)) },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
      },
      resolve: listResolver(def.name),
    };
    queryFields[`${def.name}_by_id`] = {
      type: objectType,
      description: `One \`${def.name}\` record by its \`weave_id\` (record_key).`,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: singleResolver(def.name),
    };

    const createInput = inputType('Create', def, fieldTypes, registry, enumCache);
    if (createInput !== undefined) {
      extraTypes.push(createInput);
      mutationFields[`create${typeName}`] = {
        type: new GraphQLNonNull(objectType),
        description: `Create a \`${def.name}\` record (RBAC-checked and audited).`,
        args: { data: { type: new GraphQLNonNull(createInput) } },
        resolve: createResolver(def.name),
      };
    }
    const updateInput = inputType('Update', def, fieldTypes, registry, enumCache);
    if (updateInput !== undefined) {
      extraTypes.push(updateInput);
      mutationFields[`update${typeName}`] = {
        type: new GraphQLNonNull(objectType),
        description: `Update a \`${def.name}\` record by its \`weave_id\`.`,
        args: { id: { type: new GraphQLNonNull(GraphQLID) }, changes: { type: new GraphQLNonNull(updateInput) } },
        resolve: updateResolver(def.name),
      };
    }
    mutationFields[`delete${typeName}`] = {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: `Delete a \`${def.name}\` record by its \`weave_id\`.`,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: deleteResolver(def.name),
    };
    if (def.workflow !== undefined) {
      mutationFields[`transition${typeName}`] = {
        type: new GraphQLNonNull(objectType),
        description: `Run a workflow action on a \`${def.name}\` record.`,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          action: { type: new GraphQLNonNull(GraphQLString) },
          payload: { type: GraphQLJSON },
        },
        resolve: transitionResolver(def.name),
      };
    }
  }

  queryFields._objectCount = {
    type: new GraphQLNonNull(GraphQLInt),
    description: 'Number of objects in the schema registry.',
    resolve: () => registry.list().length,
  };

  const hasObjects = registry.list().length > 0;
  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    ...(hasObjects ? { mutation: new GraphQLObjectType({ name: 'Mutation', fields: mutationFields }) } : {}),
    types: extraTypes,
  });
}

/** SDL for the compiled schema (used by `weave graphql:schema` in a later phase). */
export function printGraphQLSchema(schema: GraphQLSchema): string {
  return printSchema(schema);
}
