export { validateObject, type ValidateOptions } from './validate.js';
export { parseSchema } from './parse.js';
export {
  LEGACY_SCHEMA_FORMAT_VERSION,
  SCHEMA_FORMAT_VERSION,
  type SchemaFormatVersion,
} from './schema-version.js';
export { migrateSchemaObject, schemaVersionOf, type MigratedSchema } from './migrations.js';
export { buildGraph, RelationGraph, type BuildGraphOptions } from './graph.js';
export { ObjectRegistry, defineObject } from './registry.js';
export { generateObjectTypes } from './gen-types.js';
export {
  describeObject,
  listObjectDescriptors,
  listObjectPermissions,
  type MetadataField,
  type MetadataPermissions,
  type MetadataRelation,
  type ObjectDescriptor,
  type ObjectListEntry,
} from './describe.js';
