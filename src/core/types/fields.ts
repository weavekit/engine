import type {
  FIELD_TYPES,
  FieldType,
  OnDeleteAction,
  SequenceCycle,
} from './values.js';

export type { ScalarFieldType, FieldType, OnDeleteAction, SequenceCycle } from './values.js';

export interface FieldBase {
  name: string;
  type: FieldType;
  /** default display name (English/fallback); see `labels` for per-locale names */
  label?: string;
  /** per-locale display names, e.g. { zh: 'label-zh', en: 'Customer' } */
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

export interface DateTimeField extends FieldBase {
  type: typeof FIELD_TYPES.DATETIME;
  required?: boolean;
  unique?: boolean;
  default?: string;
}

export interface DateField extends FieldBase {
  type: typeof FIELD_TYPES.DATE;
  required?: boolean;
  unique?: boolean;
  default?: string;
}

export interface JsonField extends FieldBase {
  type: typeof FIELD_TYPES.JSON;
  required?: boolean;
  default?: unknown;
}

export interface EnumField extends FieldBase {
  type: typeof FIELD_TYPES.ENUM;
  options: string[];
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

/** discriminated union of every field shape; each member is keyed by its literal `type` */
export type FieldDefinition =
  | StringField
  | TextField
  | IntegerField
  | NumberField
  | CurrencyField
  | BooleanField
  | DateTimeField
  | DateField
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
