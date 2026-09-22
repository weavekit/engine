import type { FieldType } from './values.js';

/**
 * Field-type registration contract (open registration).
 *
 * Built-in field types are expressed as registrations too; user/plugin types
 * declare a `base` primitive and inherit all behaviour (storage / TS / MCP /
 * OpenAPI / describe) from it. The engine resolves every field through an
 * immutable {@link FieldTypeRegistry} built at load time (explicit injection —
 * no mutable global).
 */

/** single source of truth for registered-type name shape (namespace segment required) */
export const FIELD_TYPE_NAME_PATTERN = '^[a-z][a-z0-9]*(_[a-z0-9]+)+$';

/** frontend hints carried by a registration (open string — never a widget) */
export interface FieldTypeUiHints {
  visual?: string;
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
  /** extra attributes accepted on a field of this type (beyond the base attributes) */
  attrs?: readonly string[];
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
