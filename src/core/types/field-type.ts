import type { FieldType } from './values.js';
import type { RegisteredField } from './fields.js';

/**
 * Field-type registration contract (open registration).
 *
 * Built-in field types are expressed as registrations too; user/plugin types
 * declare a `base` primitive and inherit all behaviour (storage / TS / MCP /
 * OpenAPI / describe / write validation) from it. The engine resolves every
 * field through an immutable {@link FieldTypeRegistry} built at load time
 * (explicit injection — no mutable global).
 *
 * Beyond the base, a registration may declare:
 * - `attrs` — typed extra attributes a field of this type accepts (validated);
 * - `storage.pgType` — a pure function mapping the field to its PostgreSQL
 *   column type (its output is validated against a safe grammar);
 * - `validate` — a pure, synchronous write-time check (returns a detail string
 *   to reject, or `undefined` to allow);
 * - `references` — the value must exist in a column of a modeled engine object.
 */

/** single source of truth for registered-type name shape (namespace segment required) */
export const FIELD_TYPE_NAME_PATTERN = '^[a-z][a-z0-9]*(_[a-z0-9]+)+$';

/** frontend hints carried by a registration (open string — never a widget) */
export interface FieldTypeUiHints {
  visual?: string;
}

/** value kinds a declared extra attribute (`AttrSpec.type`) may take */
export const ATTR_KINDS = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  JSON: 'json',
  ENUM: 'enum',
} as const;
export type AttrKind = typeof ATTR_KINDS[keyof typeof ATTR_KINDS];

/** typed spec for one extra attribute a registered type accepts */
export interface AttrSpec {
  /** the value kind of the attribute */
  type: AttrKind;
  /** allowed values (enum only) */
  values?: readonly string[];
  /** the attribute must be declared on every field of this type */
  required?: boolean;
  /** default value (validated against the spec; not injected into the field) */
  default?: unknown;
  /** human description (docs / describe) */
  description?: string;
}

/**
 * Custom storage mapping for a registered type. `pgType` must be pure and
 * synchronous; its return value must be a PostgreSQL column type from the
 * engine's safe grammar (validated before it reaches DDL). Only valid on
 * non-relation value bases.
 */
export interface FieldTypeStorage {
  pgType: (field: RegisteredField) => string;
}

/**
 * Write-time check for a registered type: return a human-readable detail to
 * reject the value, or `undefined` to allow it. Must be pure and synchronous
 * (no I/O); DB-backed or cross-record rules belong to server hooks and
 * `references` (membership) instead.
 */
export type FieldTypeValidator = (field: RegisteredField, value: unknown) => string | undefined;

/** declarative membership check: the value must exist in a modeled object's column */
export interface FieldTypeReferences {
  /** a modeled engine object whose column must contain the value */
  object: string;
  /** the target column; defaults to the object's primary key */
  column?: string;
}

/** one field-type registration (built-in or user-defined) */
export interface FieldTypeRegistration {
  /** the type name as it appears in `schema.json` (namespace already applied) */
  name: string;
  /** namespace the loader auto-prefixed onto `name` (user types only) */
  namespace?: string;
  /** the primitive this type inherits from; `undefined` = engine primitive/structural */
  base?: FieldType;
  /** scalar (can be a primary key). Defaults from `base`. */
  scalar?: boolean;
  /** relation-like (carries `target`). Defaults from `base`. */
  relationLike?: boolean;
  /** frontend hints (consumed by `@weave-kit/ui`) */
  ui?: FieldTypeUiHints;
  /** OpenAPI `format` keyword for string-based types (e.g. `email`, `uri`) */
  openApiFormat?: string;
  /** typed extra attributes accepted on a field of this type (beyond the base attributes) */
  attrs?: Record<string, AttrSpec>;
  /** custom PostgreSQL column mapping (non-relation value bases only) */
  storage?: FieldTypeStorage;
  /** pure, synchronous write-time value check (non-relation value bases only) */
  validate?: FieldTypeValidator;
  /** value must exist in a column of a modeled object (non-relation value bases only) */
  references?: FieldTypeReferences;
  /**
   * reverse hint for `weave introspect`: a live PostgreSQL column type that maps
   * back to this registered type (e.g. `{ pgType: 'NUMERIC(12,2)' }`). Only valid
   * on non-relation value bases. When several registrations match one column the
   * primitive is kept and a warning is emitted (no ambiguity failure).
   */
  reverse?: { pgType: string; precision?: number; scale?: number };
}

/** an immutable, resolved field-type lookup */
export type FieldTypeRegistry = ReadonlyMap<string, FieldTypeRegistration>;
