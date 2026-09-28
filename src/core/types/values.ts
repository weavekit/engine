/**
 * Single source of truth for all enum-like string values.
 *
 * Every const below is `as const` and drives its union type via
 * `typeof X[keyof typeof X]`, so the value set lives in exactly one place.
 * Consumers import the const (runtime) or the derived type (compile-time).
 */

/**
 * PG-native field types: near 1:1 with a native PostgreSQL column type
 * (aliases allowed, e.g. `string`→varchar, `number`→numeric, `double`→double
 * precision). No engine-specific rules beyond the column mapping.
 */
export const PG_FIELD_TYPES = {
  STRING: 'string',
  TEXT: 'text',
  CHAR: 'char',
  SMALLINT: 'smallint',
  INTEGER: 'integer',
  BIGINT: 'bigint',
  NUMBER: 'number',
  REAL: 'real',
  DOUBLE: 'double',
  BOOLEAN: 'boolean',
  DATE: 'date',
  TIME: 'time',
  TIMETZ: 'timetz',
  TIMESTAMP: 'timestamp',
  TIMESTAMPTZ: 'timestamptz',
  INTERVAL: 'interval',
  UUID: 'uuid',
  JSON: 'json',
  JSONB: 'jsonb',
} as const;

/**
 * Engine-shipped custom field types (each may carry its own rules: enum options,
 * relation target, currency code, identity target, …). External user/plugin
 * registrations join this same category at runtime through the
 * `FieldTypeRegistry` (namespaced), so only the engine-provided ones are
 * enumerated statically here.
 */
export const BUILTIN_CUSTOM_FIELD_TYPES = {
  ENUM: 'enum',
  RELATION: 'relation',
  DETAILS: 'details',
  MULTI_RELATION: 'multiRelation',
  SEQ_NO: 'seq_no',
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  EMAIL: 'email',
  PHONE: 'phone',
  IMAGE: 'image',
  CURRENCY: 'currency',
  USER: 'user',
  DEPARTMENT: 'department',
} as const;

/** every field type: PG-native columns + engine-shipped custom types */
export const FIELD_TYPES = {
  ...PG_FIELD_TYPES,
  ...BUILTIN_CUSTOM_FIELD_TYPES,
} as const;
/** a built-in field type (the closed set the engine ships) */
export type BuiltinFieldType = typeof FIELD_TYPES[keyof typeof FIELD_TYPES];
/**
 * a field-type name: a built-in OR a user/plugin registered (namespaced) type.
 * The `(string & {})` arm keeps literal autocomplete while allowing registered
 * names; behaviour is resolved through the `FieldTypeRegistry` (base delegation).
 */
export type FieldType = BuiltinFieldType | (string & {});

/** the engine identity objects targeted by the `user`/`department` field types */
export const IDENTITY_OBJECT_NAMES = {
  USER: 'weavekit_user',
  DEPARTMENT: 'weavekit_department',
} as const;
export type IdentityObjectName = typeof IDENTITY_OBJECT_NAMES[keyof typeof IDENTITY_OBJECT_NAMES];

/** FK delete behavior for `relation` fields (default restrict) */
export const ON_DELETE_ACTIONS = {
  CASCADE: 'cascade',
  RESTRICT: 'restrict',
  SET_NULL: 'set_null',
} as const;
export type OnDeleteAction = typeof ON_DELETE_ACTIONS[keyof typeof ON_DELETE_ACTIONS];

/** row-level read/manage scope for RBAC */
export const READ_SCOPES = {
  OWN: 'own',
  DEPARTMENT: 'department',
  ALL: 'all',
} as const;
export type ReadScope = typeof READ_SCOPES[keyof typeof READ_SCOPES];

/** field markers that declare row-level scope columns (ownership/department) */
export const ROW_SCOPE_MARKERS = {
  OWNERSHIP: 'ownership',
  DEPARTMENT: 'department',
} as const;
export type RowScopeMarker = typeof ROW_SCOPE_MARKERS[keyof typeof ROW_SCOPE_MARKERS];

/**
 * where a scope column's values come from:
 * - `internal` — ids of the engine identity directory (`weavekit_*` uuids)
 * - `external` — ids from the identity source (translated via `external_id`)
 */
export const SCOPE_SOURCES = {
  INTERNAL: 'internal',
  EXTERNAL: 'external',
} as const;
export type ScopeSource = typeof SCOPE_SOURCES[keyof typeof SCOPE_SOURCES];

/** object names reserved by the engine (system objects + engine-managed tables) */
export const RESERVED_OBJECT_PREFIX = 'weavekit_';

/** index access method */
export const INDEX_TYPES = {
  BTREE: 'btree',
  GIN: 'gin',
  GIST: 'gist',
} as const;
export type IndexType = typeof INDEX_TYPES[keyof typeof INDEX_TYPES];

/** declarative table-level constraint kinds */
export const CONSTRAINT_TYPES = {
  UNIQUE: 'unique',
} as const;
export type ConstraintType = typeof CONSTRAINT_TYPES[keyof typeof CONSTRAINT_TYPES];

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

/**
 * Engine-managed record instance status (`weave_status`). The workflow runtime
 * drives transitions between these; a record with no engine metadata defaults
 * to `draft`.
 */
export const WEAVE_STATUS = {
  DRAFT: 'draft',
  RUNNING: 'running',
  EFFECTIVE: 'effective',
  CANCELED: 'canceled',
} as const;
export type WeaveStatus = typeof WEAVE_STATUS[keyof typeof WEAVE_STATUS];

/** relation edge kinds in the normalized RelationGraph */
export const RELATION_KINDS = {
  BELONGS_TO: 'belongsTo',
  HAS_MANY: 'hasMany',
  MULTI_RELATION: 'multiRelation',
} as const;
export type RelationKind = typeof RELATION_KINDS[keyof typeof RELATION_KINDS];
