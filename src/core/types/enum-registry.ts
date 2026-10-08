/**
 * Named-enum registry (schema v6) — the single source for project-level enum
 * declarations (`enums/<name>.json`).
 *
 * A field references a declared enum by its `enumType`; every field that shares
 * an `enumType` shares one native PostgreSQL enum type. This mirrors the
 * field-type registry: a pure, explicitly-threaded lookup (no mutable global).
 *
 * The registry only indexes validated definitions; shape/consistency checks
 * live in `core/object/enums.ts` (which carries the locale).
 */
export interface EnumDefinition {
  /** enum name; equals the field `enumType` and the PostgreSQL type name (snake_case) */
  name: string;
  /** allowed values (non-empty, unique) */
  values: string[];
  /** per-value display names, keyed by locale then value: locale → value → label */
  labels?: Record<string, Record<string, string>>;
}

/** lookup contract for declared enums; explicitly threaded through validation/consumers */
export interface EnumRegistry {
  /** the declared enum with this name, or undefined */
  get(name: string): EnumDefinition | undefined;
  /** true when a declaration exists for this name */
  has(name: string): boolean;
  /** all declarations */
  list(): EnumDefinition[];
}

const EMPTY_ENUM_REGISTRY: EnumRegistry = {
  get: () => undefined,
  has: () => false,
  list: () => [],
};

/** the default (empty) registry: no named enums declared — inline enums behave as before */
export const DEFAULT_ENUM_REGISTRY: EnumRegistry = EMPTY_ENUM_REGISTRY;

/** build an effective registry from validated definitions (pure; last definition wins) */
export function buildEnumRegistry(definitions: readonly EnumDefinition[] = []): EnumRegistry {
  if (definitions.length === 0) return EMPTY_ENUM_REGISTRY;
  const map = new Map<string, EnumDefinition>();
  for (const definition of definitions) map.set(definition.name, definition);
  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    list: () => [...map.values()],
  };
}
