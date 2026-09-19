import { FIELD_TYPES, SCALAR_FIELD_TYPES, type FieldType } from './values.js';

/**
 * Field-type registry — the single source for the engine's field-type
 * descriptors. Primitive types (scalar + relation + sequence) carry `base:
 * undefined`; semantic types (string subtypes, media, identity FKs) carry a
 * `base` they fully inherit (storage/describe/gen-types/MCP behavior), plus a
 * small `ui` hints block consumed by `@weave-kit/ui`. Schema-level gating lives
 * in the config `features.fieldTypes` whitelist (see validate.ts), NOT here.
 */

export interface FieldTypeUiHints {
  /** leading visual kind rendered in list/show (avatar / building icon / none) */
  visual?: 'avatar' | 'icon' | 'image' | 'none';
}

export interface FieldTypeDescriptor {
  name: FieldType;
  /** the inherited field type; `undefined` = engine primitive. */
  base?: FieldType;
  /** scalar (can be a primary key). */
  scalar?: boolean;
  /** relation-like (target via FK). */
  relationLike?: boolean;
  /** frontend hints (consumed by @weave-kit/ui). */
  ui?: FieldTypeUiHints;
}

const registry = new Map<FieldType, FieldTypeDescriptor>();

function define(descriptor: FieldTypeDescriptor): void {
  registry.set(descriptor.name, descriptor);
}

// ---- primitives ----
define({ name: FIELD_TYPES.STRING, scalar: true });
define({ name: FIELD_TYPES.TEXT, scalar: true });
define({ name: FIELD_TYPES.INTEGER, scalar: true });
define({ name: FIELD_TYPES.NUMBER, scalar: true });
define({ name: FIELD_TYPES.CURRENCY, scalar: true });
define({ name: FIELD_TYPES.BOOLEAN, scalar: true });
define({ name: FIELD_TYPES.DATETIME, scalar: true });
define({ name: FIELD_TYPES.DATE, scalar: true });
define({ name: FIELD_TYPES.JSON, scalar: true });
define({ name: FIELD_TYPES.ENUM, scalar: true });
define({ name: FIELD_TYPES.RELATION, relationLike: true });
define({ name: FIELD_TYPES.DETAILS, relationLike: true });
define({ name: FIELD_TYPES.MULTI_RELATION, relationLike: true });
define({ name: FIELD_TYPES.SEQ_NO });

// ---- semantic types (base delegation + ui hints) ----
define({ name: FIELD_TYPES.FIRST_NAME, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'none' } });
define({ name: FIELD_TYPES.LAST_NAME, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'none' } });
define({ name: FIELD_TYPES.EMAIL, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'none' } });
define({ name: FIELD_TYPES.PHONE, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'none' } });
define({ name: FIELD_TYPES.IMAGE, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'image' } });
define({ name: FIELD_TYPES.PERSON, base: FIELD_TYPES.RELATION, relationLike: true, ui: { visual: 'avatar' } });
define({ name: FIELD_TYPES.DEPARTMENT, base: FIELD_TYPES.RELATION, relationLike: true, ui: { visual: 'icon' } });

/** the base primitive a type inherits (walks one level). */
export function fieldBase(type: FieldType): FieldType {
  const desc = registry.get(type);
  return desc?.base ?? type;
}

/** true for a relation-like field (target-by-FK). */
export function isRelationLike(type: FieldType): boolean {
  return registry.get(type)?.relationLike === true;
}

/** true for a field type that can be a primary key. */
export function isScalarFieldType(type: FieldType): boolean {
  const base = fieldBase(type);
  return base in SCALAR_FIELD_TYPES;
}

/** the frontend visual hint for a type (single source). */
export function fieldUiVisual(type: FieldType): FieldTypeUiHints['visual'] {
  return registry.get(type)?.ui?.visual ?? 'none';
}

/** a descriptor (or undefined for an unknown type). */
export function describeFieldType(type: FieldType): FieldTypeDescriptor | undefined {
  return registry.get(type);
}

/** engine primitives — always allowed by the default whitelist. */
export const PRIMITIVE_FIELD_TYPES: readonly FieldType[] = [
  FIELD_TYPES.STRING,
  FIELD_TYPES.TEXT,
  FIELD_TYPES.INTEGER,
  FIELD_TYPES.NUMBER,
  FIELD_TYPES.CURRENCY,
  FIELD_TYPES.BOOLEAN,
  FIELD_TYPES.DATETIME,
  FIELD_TYPES.DATE,
  FIELD_TYPES.JSON,
  FIELD_TYPES.ENUM,
  FIELD_TYPES.RELATION,
  FIELD_TYPES.DETAILS,
  FIELD_TYPES.MULTI_RELATION,
  FIELD_TYPES.SEQ_NO,
];

/** semantic types that are gated by the config `features.fieldTypes` whitelist. */
export const SEMANTIC_FIELD_TYPES: readonly FieldType[] = [
  FIELD_TYPES.FIRST_NAME,
  FIELD_TYPES.LAST_NAME,
  FIELD_TYPES.EMAIL,
  FIELD_TYPES.PHONE,
  FIELD_TYPES.IMAGE,
  FIELD_TYPES.PERSON,
  FIELD_TYPES.DEPARTMENT,
];
