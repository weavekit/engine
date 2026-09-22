export type { ScalarFieldType, BuiltinFieldType, FieldType, OnDeleteAction } from './fields.js';
export type {
  FieldBase,
  StringField,
  TextField,
  IntegerField,
  NumberField,
  CurrencyField,
  BooleanField,
  DateTimeField,
  DateField,
  JsonField,
  EnumField,
  RelationField,
  DetailsField,
  MultiRelationField,
  SeqNoField,
  FieldDefinition,
} from './fields.js';
export type { ReadScope, PermissionDefinition, Permissions } from './permission.js';
export type {
  BelongsToEdge,
  HasManyEdge,
  MultiRelationEdge,
  RelationEdge,
} from './relation.js';
export type { IndexDefinition, ObjectDefinition } from './object.js';
export type { IndexType, SequenceCycle, SequenceToken, DetailsColumn, RelationKind, RowScopeMarker } from './values.js';
export { DETAILS_COLUMNS, FIELD_TYPES, READ_SCOPES, RELATION_KINDS, ROW_SCOPE_MARKERS } from './values.js';
export { primaryFieldOf, primaryKeyOf } from './primaryField.js';
export { SchemaError } from './errors.js';

export {
  buildFieldTypeRegistry,
  DEFAULT_FIELD_TYPE_REGISTRY,
  describeFieldType,
  fieldBase,
  fieldOpenApiFormat,
  fieldUiVisual,
  isRelationLike,
  isScalarFieldType,
  PRIMITIVE_FIELD_TYPES,
  SEMANTIC_FIELD_TYPES,
} from './registry.js';
export type { FieldTypeRegistration, FieldTypeRegistry, FieldTypeUiHints } from './field-type.js';
export { FIELD_TYPE_NAME_PATTERN } from './field-type.js';
