/**
 * System-schema scope.
 *
 * By default the engine's own tables (`weavekit_*` system tables, the
 * `weavekit_record__<object>` metadata side tables and the `weavekit_m2m__*`
 * link tables) live in the connection's `current_schema()` alongside customer
 * tables. `EngineConfig.systemSchema` moves them into a dedicated schema so a
 * DBA reviewing the customer schema does not see engine plumbing.
 *
 * The mechanism is **explicit qualification** (not `search_path`): every emitted
 * identifier for an engine table is qualified with the configured schema, and
 * identifiers left unqualified (customer + identity object tables) resolve to
 * the object schema. `undefined` reproduces the legacy behaviour exactly.
 */

/** a validated lowercase PostgreSQL identifier */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** the schema that holds engine-owned tables; `undefined` = connection default */
export interface SchemaScope {
  readonly systemSchema?: string;
}

/** the scope used when no system schema is configured (legacy behaviour) */
export const DEFAULT_SCHEMA_SCOPE: SchemaScope = {};

/** fail-closed validation of a configured system-schema name */
export function assertSchemaName(name: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`invalid systemSchema "${name}" (expected a lowercase identifier like "weavekit")`);
  }
}

/** build a scope from config (validates the identifier); `undefined` → default */
export function createSchemaScope(systemSchema?: string): SchemaScope {
  if (systemSchema === undefined) return DEFAULT_SCHEMA_SCOPE;
  assertSchemaName(systemSchema);
  return { systemSchema };
}

/** true when a dedicated system schema is configured */
export function isScoped(scope?: SchemaScope): boolean {
  return scope?.systemSchema !== undefined;
}

/**
 * Quote a bare table name, qualified to the system schema when one is set.
 * Callers pass the engine table's base name (e.g. `SYSTEM_TABLES.AUDIT` or
 * `recordMetaTableName(object)`).
 */
export function qualifyTable(name: string, scope?: SchemaScope): string {
  const schema = scope?.systemSchema;
  return schema === undefined ? `"${name}"` : `"${schema}"."${name}"`;
}
