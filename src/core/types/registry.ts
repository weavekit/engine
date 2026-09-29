import { FIELD_TYPES, PG_FIELD_TYPES, type FieldType } from './values.js';
import type { FieldTypeRegistration, FieldTypeRegistry } from './field-type.js';

/**
 * Field-type registry — the single source for the engine's field-type
 * descriptors. PG-native types carry `base: undefined`; custom types may carry a
 * `base` they fully inherit (storage/describe/gen-types/MCP behaviour) plus a
 * small `ui` hints block consumed by `@weave-kit/ui`. Schema-level gating lives
 * in the config `features.fieldTypes` whitelist (see validate.ts), NOT here.
 *
 * The same registration shape carries user/plugin types (`buildFieldTypeRegistry`),
 * so built-ins and extensions resolve through one mechanism.
 */

const registry = new Map<string, FieldTypeRegistration>();

function define(descriptor: FieldTypeRegistration): void {
  registry.set(descriptor.name, descriptor);
}

// ---- PG-native value primitives (value scalars; PK-eligible as a base) ----
for (const name of Object.values(PG_FIELD_TYPES)) define({ name, scalar: true });

// value scalars PostgreSQL cannot use as a primary key: json/jsonb are not
// comparable for a key and real/double/interval have no natural equality. They
// stay scalar (usable as values, e.g. formula refs) but are not key-eligible.
const KEY_INELIGIBLE: readonly FieldType[] = [
  FIELD_TYPES.JSON,
  FIELD_TYPES.JSONB,
  FIELD_TYPES.INTERVAL,
  FIELD_TYPES.REAL,
  FIELD_TYPES.DOUBLE,
];
for (const name of KEY_INELIGIBLE) define({ name, scalar: true, keyEligible: false });

// ---- engine custom primitives (each may carry its own rules) ----
define({ name: FIELD_TYPES.ENUM, scalar: true });
define({ name: FIELD_TYPES.RELATION, relationLike: true });
define({ name: FIELD_TYPES.DETAILS, relationLike: true });
define({ name: FIELD_TYPES.MULTI_RELATION, relationLike: true });
define({ name: FIELD_TYPES.SEQ_NO });
define({ name: FIELD_TYPES.CURRENCY, scalar: true });

// ---- engine custom types with base delegation + ui/format hints ----
define({ name: FIELD_TYPES.FIRST_NAME, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'none' } });
define({ name: FIELD_TYPES.LAST_NAME, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'none' } });
define({ name: FIELD_TYPES.EMAIL, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'none' }, openApiFormat: 'email' });
define({ name: FIELD_TYPES.PHONE, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'none' } });
define({ name: FIELD_TYPES.IMAGE, base: FIELD_TYPES.STRING, scalar: true, ui: { visual: 'image' }, openApiFormat: 'uri' });

// ---- identity FK types (relation-like; implicit target = the identity objects) ----
define({ name: FIELD_TYPES.USER, base: FIELD_TYPES.RELATION, relationLike: true, ui: { visual: 'avatar' } });
define({ name: FIELD_TYPES.DEPARTMENT, base: FIELD_TYPES.RELATION, relationLike: true, ui: { visual: 'icon' } });

/** the default registry: every engine built-in type (immutable by convention) */
export const DEFAULT_FIELD_TYPE_REGISTRY: FieldTypeRegistry = registry;

/**
 * Build an effective registry from the built-in types plus user registrations
 * (pure; never mutates the default registry). Later definitions must not
 * collide with an existing name — the loader validates this before calling.
 */
export function buildFieldTypeRegistry(extra: readonly FieldTypeRegistration[] = []): FieldTypeRegistry {
  if (extra.length === 0) return registry;
  const merged = new Map<string, FieldTypeRegistration>(registry);
  for (const descriptor of extra) merged.set(descriptor.name, descriptor);
  return merged;
}

/** the base primitive a type inherits (walks one level; self for primitives) */
export function fieldBase(registry: FieldTypeRegistry, type: FieldType): FieldType {
  return registry.get(type)?.base ?? type;
}

/** true for a relation-like field (target-by-FK) */
export function isRelationLike(registry: FieldTypeRegistry, type: FieldType): boolean {
  const desc = registry.get(type);
  if (desc?.relationLike !== undefined) return desc.relationLike;
  return registry.get(fieldBase(registry, type))?.relationLike === true;
}

/** true for a scalar value type (see `isKeyEligible` for primary-key use) */
export function isScalarFieldType(registry: FieldTypeRegistry, type: FieldType): boolean {
  const desc = registry.get(type);
  if (desc?.scalar !== undefined) return desc.scalar;
  return registry.get(fieldBase(registry, type))?.scalar === true;
}

/** true for a field type eligible as a primary key (scalar + key-eligible) */
export function isKeyEligible(registry: FieldTypeRegistry, type: FieldType): boolean {
  const desc = registry.get(type);
  if (desc?.keyEligible !== undefined) return desc.keyEligible;
  const base = desc?.base;
  if (base !== undefined) return registry.get(base)?.keyEligible !== false;
  return isScalarFieldType(registry, type);
}

/** the frontend visual hint for a type (single source) */
export function fieldUiVisual(registry: FieldTypeRegistry, type: FieldType): string {
  return registry.get(type)?.ui?.visual ?? 'none';
}

/** the OpenAPI `format` hint for a type, if any */
export function fieldOpenApiFormat(registry: FieldTypeRegistry, type: FieldType): string | undefined {
  return registry.get(type)?.openApiFormat;
}

/** a descriptor (or undefined for an unknown type) */
export function describeFieldType(registry: FieldTypeRegistry, type: FieldType): FieldTypeRegistration | undefined {
  return registry.get(type);
}

/** always-enabled types — every scaffold preset (including `agent`) starts from these. */
export const PRIMITIVE_FIELD_TYPES: readonly FieldType[] = [
  ...Object.values(PG_FIELD_TYPES),
  FIELD_TYPES.ENUM,
  FIELD_TYPES.RELATION,
  FIELD_TYPES.DETAILS,
  FIELD_TYPES.MULTI_RELATION,
  FIELD_TYPES.SEQ_NO,
  FIELD_TYPES.CURRENCY,
];

/** opt-in types — the non-`agent` presets add these; `features.fieldTypes` gates them. */
export const OPT_IN_FIELD_TYPES: readonly FieldType[] = [
  FIELD_TYPES.FIRST_NAME,
  FIELD_TYPES.LAST_NAME,
  FIELD_TYPES.EMAIL,
  FIELD_TYPES.PHONE,
  FIELD_TYPES.IMAGE,
  FIELD_TYPES.USER,
  FIELD_TYPES.DEPARTMENT,
];
