import type {
  BuiltinFieldType,
  FIELD_TYPES,
  OnDeleteAction,
  SequenceCycle,
} from './values.js';

export type { ScalarFieldType, BuiltinFieldType, FieldType, OnDeleteAction, SequenceCycle } from './values.js';

export interface FieldBase {
  name: string;
  /**
   * the declared type name. Built-in literals for engine types; a registered
   * (namespaced) name is produced at validation and stored via a narrow cast —
   * runtime behaviour is resolved through the `FieldTypeRegistry`.
   */
  type: BuiltinFieldType;
  /**
   * display names keyed by locale, e.g. { en: 'Customer', zh: '客户' }. Resolve
   * with `resolveLabel` (falls back to `name` when absent).
   */
  labels?: Record<string, string>;
  /** free-text description surfaced via describe_object */
  description?: string;
  /** declares this field as the new-table primary key (exactly one per new object) */
  primary?: boolean;
  /** user-declared system-reserved field marker (engine protects values/schema ops) */
  system?: boolean;
  /** row-level ownership marker (RBAC read=own); string fields only, at most one per object */
  ownership?: boolean;
  /** row-level team marker (RBAC read=team); string fields only, at most one per object */
  team?: boolean;
  /**
   * secret field: masked (omitted) from every REST read response — written
   * normally (create/update), never read back over REST. The data-access layer
   * still returns it to server-side consumers (e.g. the proxy resolver), so
   * secrets never reach the browser.
   */
  sensitive?: boolean;
}

export interface StringField extends FieldBase {
  type: typeof FIELD_TYPES.STRING;
  minLength?: number;
  maxLength?: number;
  regex?: string;
  required?: boolean;
  unique?: boolean;
  default?: string;
  /** computed field expression */
  formula?: string;
}

export interface TextField extends FieldBase {
  type: typeof FIELD_TYPES.TEXT;
  maxLength?: number;
  required?: boolean;
  unique?: boolean;
  default?: string;
  formula?: string;
}

export interface IntegerField extends FieldBase {
  type: typeof FIELD_TYPES.INTEGER;
  min?: number;
  max?: number;
  required?: boolean;
  unique?: boolean;
  default?: number;
  formula?: string;
}

export interface NumberField extends FieldBase {
  type: typeof FIELD_TYPES.NUMBER;
  min?: number;
  max?: number;
  precision?: number;
  required?: boolean;
  unique?: boolean;
  default?: number;
  formula?: string;
}

export interface CurrencyField extends FieldBase {
  type: typeof FIELD_TYPES.CURRENCY;
  min?: number;
  max?: number;
  required?: boolean;
  unique?: boolean;
  default?: number;
  formula?: string;
}

export interface BooleanField extends FieldBase {
  type: typeof FIELD_TYPES.BOOLEAN;
  required?: boolean;
  unique?: boolean;
  default?: boolean;
  formula?: string;
}

/** shared shape for the date/time family (a scalar column with an optional textual default) */
interface TemporalFieldBase extends FieldBase {
  required?: boolean;
  unique?: boolean;
  default?: string;
}

export interface DateField extends TemporalFieldBase {
  type: typeof FIELD_TYPES.DATE;
}

export interface TimeField extends TemporalFieldBase {
  type: typeof FIELD_TYPES.TIME;
}

export interface TimeTzField extends TemporalFieldBase {
  type: typeof FIELD_TYPES.TIMETZ;
}

export interface TimestampField extends TemporalFieldBase {
  type: typeof FIELD_TYPES.TIMESTAMP;
}

export interface TimestamptzField extends TemporalFieldBase {
  type: typeof FIELD_TYPES.TIMESTAMPTZ;
}

/** interval is a value scalar but not PK-eligible (no textual default in DDL) */
export interface IntervalField extends FieldBase {
  type: typeof FIELD_TYPES.INTERVAL;
  required?: boolean;
  unique?: boolean;
}

export interface JsonField extends FieldBase {
  type: typeof FIELD_TYPES.JSON;
  required?: boolean;
  default?: unknown;
}

/**
 * Enum option source: an inline list of strings, or a data-driven source
 * (`{ from: { object, column? } }`) whose allowed values are the distinct
 * values of a modeled object's column (default: the object's primary key).
 */
export type EnumOptions = string[] | { from: { object: string; column?: string } };

export interface EnumField extends FieldBase {
  type: typeof FIELD_TYPES.ENUM;
  /** inline options, or a data-driven `{ from: { object, column? } }` source */
  options: EnumOptions;
  multiple?: boolean;
  required?: boolean;
  unique?: boolean;
  default?: string | string[];
}

export interface RelationField extends FieldBase {
  type: typeof FIELD_TYPES.RELATION;
  target: string;
  required?: boolean;
  unique?: boolean;
  onDelete?: OnDeleteAction;
}

export interface DetailsField extends FieldBase {
  type: typeof FIELD_TYPES.DETAILS;
  target: string;
}

export interface MultiRelationField extends FieldBase {
  type: typeof FIELD_TYPES.MULTI_RELATION;
  target: string;
  required?: boolean;
}

export interface SeqNoField extends FieldBase {
  type: typeof FIELD_TYPES.SEQ_NO;
  format?: string;
  cycle?: SequenceCycle;
}

/** string subtype (person names + contact); inherits `string` column + validation */
export interface NameFieldBase extends FieldBase {
  minLength?: number;
  maxLength?: number;
  regex?: string;
  required?: boolean;
  unique?: boolean;
  default?: string;
  formula?: string;
}

export interface FirstNameField extends NameFieldBase {
  type: typeof FIELD_TYPES.FIRST_NAME;
}

export interface LastNameField extends NameFieldBase {
  type: typeof FIELD_TYPES.LAST_NAME;
}

export interface EmailField extends NameFieldBase {
  type: typeof FIELD_TYPES.EMAIL;
}

export interface PhoneField extends NameFieldBase {
  type: typeof FIELD_TYPES.PHONE;
}

/** media field (image/asset); maps to a URL/file column, single or multi */
export interface ImageField extends FieldBase {
  type: typeof FIELD_TYPES.IMAGE;
  required?: boolean;
  unique?: boolean;
  /** multi-value (TEXT[]): an array of URLs */
  multiple?: boolean;
  default?: string | string[];
}

/** identity FK to the internal address-book/person object (relation-like, mirrors RelationField) */
export interface PersonField extends FieldBase {
  type: typeof FIELD_TYPES.PERSON;
  target: string;
  required?: boolean;
  unique?: boolean;
  onDelete?: OnDeleteAction;
  /**
   * the department FK field name on the *person target* object (e.g. `dept_id`).
   * Lets the resolve layer pull the person's department (department icon + name).
   */
  department?: string;
}

/** identity FK to the internal department/organization object (relation-like, mirrors RelationField) */
export interface DepartmentField extends FieldBase {
  type: typeof FIELD_TYPES.DEPARTMENT;
  target: string;
  required?: boolean;
  unique?: boolean;
  onDelete?: OnDeleteAction;
}

/**
 * a field whose `type` is a user/plugin registered type. Stored on
 * `ObjectDefinition.fields` via a narrow cast (registered fields are not part of
 * the `FieldDefinition` discriminated union, so built-in narrowing is preserved);
 * behaviour is inherited from the registration's `base` primitive.
 */
export interface RegisteredField extends Omit<FieldBase, 'type'> {
  type: string;
  target?: string;
  required?: boolean;
  unique?: boolean;
  multiple?: boolean;
  [key: string]: unknown;
}

/** discriminated union of every field shape; each member is keyed by its literal `type` */
export type FieldDefinition =
  | StringField
  | TextField
  | IntegerField
  | NumberField
  | CurrencyField
  | BooleanField
  | DateField
  | TimeField
  | TimeTzField
  | TimestampField
  | TimestamptzField
  | IntervalField
  | JsonField
  | EnumField
  | RelationField
  | DetailsField
  | MultiRelationField
  | SeqNoField
  | FirstNameField
  | LastNameField
  | EmailField
  | PhoneField
  | ImageField
  | PersonField
  | DepartmentField;
