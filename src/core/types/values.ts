/**
 * Single source of truth for all enum-like string values.
 *
 * Every const below is `as const` and drives its union type via
 * `typeof X[keyof typeof X]`, so the value set lives in exactly one place.
 * Consumers import the const (runtime) or the derived type (compile-time).
 */

/** every field type: scalar + relation + sequence */
export const FIELD_TYPES = {
  STRING: 'string',
  TEXT: 'text',
  INTEGER: 'integer',
  NUMBER: 'number',
  CURRENCY: 'currency',
  BOOLEAN: 'boolean',
  DATETIME: 'datetime',
  DATE: 'date',
  JSON: 'json',
  ENUM: 'enum',
  RELATION: 'relation',
  DETAILS: 'details',
  MULTI_RELATION: 'multiRelation',
  SEQ_NO: 'seq_no',
  // string subtypes (first/last name, contact) and media (image/asset)
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  EMAIL: 'email',
  PHONE: 'phone',
  IMAGE: 'image',
  // identity FK to the internal address-book/person object (relation-like; not scalar)
  PERSON: 'person',
  // identity FK to the internal department/organization object (relation-like; not scalar)
  DEPARTMENT: 'department',
} as const;
export type FieldType = typeof FIELD_TYPES[keyof typeof FIELD_TYPES];

/** scalar subset of FIELD_TYPES (primary key only allows scalar types) */
export const SCALAR_FIELD_TYPES = {
  STRING: 'string',
  TEXT: 'text',
  INTEGER: 'integer',
  NUMBER: 'number',
  CURRENCY: 'currency',
  BOOLEAN: 'boolean',
  DATETIME: 'datetime',
  DATE: 'date',
  JSON: 'json',
  ENUM: 'enum',
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  EMAIL: 'email',
  PHONE: 'phone',
  IMAGE: 'image',
} as const;
export type ScalarFieldType = typeof SCALAR_FIELD_TYPES[keyof typeof SCALAR_FIELD_TYPES];

/** FK delete behavior for `relation` fields (default restrict) */
export const ON_DELETE_ACTIONS = {
  CASCADE: 'cascade',
  RESTRICT: 'restrict',
  SET_NULL: 'set_null',
} as const;
export type OnDeleteAction = typeof ON_DELETE_ACTIONS[keyof typeof ON_DELETE_ACTIONS];

/** row-level read scope for RBAC */
export const READ_SCOPES = {
  OWN: 'own',
  TEAM: 'team',
  ALL: 'all',
} as const;
export type ReadScope = typeof READ_SCOPES[keyof typeof READ_SCOPES];

/** field markers that declare row-level scope columns (ownership/team) */
export const ROW_SCOPE_MARKERS = {
  OWNERSHIP: 'ownership',
  TEAM: 'team',
} as const;
export type RowScopeMarker = typeof ROW_SCOPE_MARKERS[keyof typeof ROW_SCOPE_MARKERS];

/** index access method */
export const INDEX_TYPES = {
  BTREE: 'btree',
  GIN: 'gin',
  GIST: 'gist',
} as const;
export type IndexType = typeof INDEX_TYPES[keyof typeof INDEX_TYPES];

/** seq_no counter restart strategy */
export const SEQUENCE_CYCLES = {
  NONE: 'none',
  YEAR: 'year',
} as const;
export type SequenceCycle = typeof SEQUENCE_CYCLES[keyof typeof SEQUENCE_CYCLES];

/** placeholders allowed inside a seq_no `format` template */
export const SEQUENCE_TOKENS = {
  SEQ: 'seq',
  YEAR: 'year',
  MONTH: 'month',
  DAY: 'day',
} as const;
export type SequenceToken = typeof SEQUENCE_TOKENS[keyof typeof SEQUENCE_TOKENS];

/** engine-managed columns auto-added to a details child table */
export const DETAILS_COLUMNS = {
  PARENT_ID: 'parent_id',
  PARENT_TYPE: 'parent_type',
  PARENT_IDX: 'parent_idx',
} as const;
export type DetailsColumn = typeof DETAILS_COLUMNS[keyof typeof DETAILS_COLUMNS];

/** relation edge kinds in the normalized RelationGraph */
export const RELATION_KINDS = {
  BELONGS_TO: 'belongsTo',
  HAS_MANY: 'hasMany',
  MULTI_RELATION: 'multiRelation',
} as const;
export type RelationKind = typeof RELATION_KINDS[keyof typeof RELATION_KINDS];
