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
  type GraphQLFieldConfigMap,
  type GraphQLOutputType,
} from 'graphql';
import {
  FIELD_TYPES,
  fieldBase,
  isRelationLike,
  RECORD_META_ID_FIELD,
  type EnumField,
  type FieldDefinition,
  type FieldTypeRegistry,
} from '../../core/index.js';
import { GraphQLJSON } from './scalars.js';
import { listResolver, singleResolver } from './resolvers.js';
import type { GraphQLContext, GraphQLEngine } from './types.js';

/**
 * Compile the object registry into a GraphQL schema (Phase 1: scalar fields +
 * read-only Query). Build is **programmatic** (per the plan) so `printSchema`
 * can emit SDL for `weave graphql:schema`.
 *
 * Field-level RBAC is enforced at resolve time (the resolvers call the
 * RBAC-decorated data-access layer), so the schema is identity-agnostic — a
 * denied object/field resolves to a `rbac.denied.*` error / null rather than
 * being clipped per identity.
 *
 * Relations (`relation`/`details`/`multiRelation`) and Mutations land in
 * Phases 2–3. `filter` is the free-form JSON filter (same contract as REST/MCP);
 * `sort` is a shared `SortInput` list.
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
  if (isRelationLike(registry, field.type)) return undefined; // Phase 3
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

/** the fields of one object type: scalar/enum/json columns + the read-only `weave_id` */
function objectFields(
  def: { name: string; fields: FieldDefinition[] },
  registry: FieldTypeRegistry,
  cache: Map<string, GraphQLEnumType>,
): GraphQLFieldConfigMap<unknown, GraphQLContext> {
  const fields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {
    [RECORD_META_ID_FIELD]: {
      type: new GraphQLNonNull(GraphQLID),
      description: "The record id (its `record_key`).",
    },
  };
  for (const field of def.fields) {
    const type = fieldType(field, registry, def.name, cache);
    if (type === undefined) continue;
    fields[field.name] = { type, ...(field.description === undefined ? {} : { description: field.description }) };
  }
  return fields;
}

/** compile the registry into a GraphQL schema */
export function buildGraphQLSchema(engine: GraphQLEngine): GraphQLSchema {
  const registry = engine.registry;
  const fieldTypes = registry.fieldTypes;
  const enumCache = new Map<string, GraphQLEnumType>();
  const objectTypes = new Map<string, GraphQLObjectType>();

  for (const def of registry.list()) {
    objectTypes.set(
      def.name,
      new GraphQLObjectType({
        name: pascalCase(def.name),
        ...(def.description === undefined ? {} : { description: def.description }),
        fields: () => objectFields(def, fieldTypes, enumCache),
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
  for (const def of registry.list()) {
    const objectType = objectTypes.get(def.name) as GraphQLObjectType;
    const pageType = new GraphQLObjectType({
      name: `${pascalCase(def.name)}Page`,
      fields: {
        rows: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))) },
        total: { type: new GraphQLNonNull(GraphQLInt) },
      },
    });
    queryFields[def.name] = {
      type: new GraphQLNonNull(pageType),
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
  }

  queryFields._objectCount = {
    type: new GraphQLNonNull(GraphQLInt),
    description: 'Number of objects in the schema registry.',
    resolve: () => registry.list().length,
  };

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    types: [sortInput],
  });
}

/** SDL for the compiled schema (used by `weave graphql:schema` in a later phase). */
export function printGraphQLSchema(schema: GraphQLSchema): string {
  return printSchema(schema);
}
