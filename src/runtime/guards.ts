import type { Pool } from 'pg';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  SchemaError,
  inspectSchema,
  isSafeRlsRole,
  planObjectRls,
  OBJECT_RLS_ROLE_DEFAULT,
  type Locale,
  type ObjectRegistry,
  type SchemaScope,
} from '../core/index.js';
import type { EngineConfig } from './config-types.js';

/**
 * Engine start-up resolution + fail-closed guards — extracted from `engine.ts`
 * (2.1 maintainability). Pure resolution helpers and the least-privilege / RLS
 * provisioning checks the assembly runs before serving.
 */

export function resolveLocale(configLocale: Locale | undefined): Locale {
  const resolved = configLocale ?? (process.env.WEAVEKIT_LOCALE as Locale | undefined) ?? DEFAULT_LOCALE;
  const supported = new Set<Locale>(SUPPORTED_LOCALES);
  return supported.has(resolved) ? resolved : DEFAULT_LOCALE;
}

/**
 * Whether the runtime database account must be least-privileged (no schema
 * `CREATE`). Resolution: explicit `config.runtime.requireRestrictedAccount` →
 * env `WEAVEKIT_REQUIRE_RESTRICTED_ACCOUNT` → default `true`.
 */
export function resolveRequireRestrictedAccount(config: EngineConfig): boolean {
  const configured = config.runtime?.requireRestrictedAccount;
  if (configured !== undefined) return configured;
  const env = process.env.WEAVEKIT_REQUIRE_RESTRICTED_ACCOUNT;
  if (env !== undefined) return env !== 'false' && env !== '0';
  return true;
}

/** the object-path RLS role when `rls.enforce` is on, else undefined */
export function resolveObjectRlsRole(config: Pick<EngineConfig, 'rls'>): string | undefined {
  return config.rls?.enforce === true ? (config.rls.role ?? OBJECT_RLS_ROLE_DEFAULT) : undefined;
}

/**
 * Fail-closed guard for `rls.enforce`: the role must exist and be grantable to
 * the runtime account, and every object table must carry the current policies
 * and privileges (i.e. `weave migrate` ran with enforcement on).
 */
export async function assertObjectRlsProvisioned(
  pool: Pool,
  registry: ObjectRegistry,
  role: string,
  locale: Locale,
  scope?: SchemaScope,
): Promise<void> {
  if (!isSafeRlsRole(role)) throw new SchemaError('engine.rls.notProvisioned', { detail: `invalid role "${role}"` }, locale);
  const { rows } = await pool.query<{ present: boolean; member: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present,
            CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
                 THEN pg_has_role(current_user, $1, 'MEMBER') ELSE false END AS member`,
    [role],
  );
  if (rows[0]?.member !== true) {
    const detail = rows[0]?.present === true ? `role "${role}" is not granted to the runtime account` : `role "${role}" is missing`;
    throw new SchemaError('engine.rls.notProvisioned', { detail }, locale);
  }
  const objectActual = await inspectSchema(pool);
  const actual =
    scope?.systemSchema === undefined
      ? objectActual
      : new Map([...objectActual, ...(await inspectSchema(pool, { schema: scope.systemSchema }))]);
  const plan = planObjectRls(registry, actual, role, { scope });
  if (plan.statements.length > 0) {
    const tables = [...new Set(plan.statements.map((s) => /"([^"]+)"/.exec(s)?.[1]).filter((t): t is string => t !== undefined))];
    throw new SchemaError('engine.rls.notProvisioned', { detail: `missing policies/privileges on ${tables.join(', ')}` }, locale);
  }
}

/**
 * Fail-closed guard: refuse to start when the runtime account can create
 * objects in the current schema. WeaveKit runs DDL only via `weave migrate`
 * (with `migrationDatabaseUrl`); a runtime account with `CREATE` defeats the
 * least-privilege model.
 */
export async function assertRestrictedRuntimeAccount(
  pool: Pool,
  config: EngineConfig,
  locale: Locale,
): Promise<void> {
  if (!resolveRequireRestrictedAccount(config)) return;
  const { rows } = await pool.query<{ user: string; can_create: boolean }>(
    `SELECT current_user AS user, has_schema_privilege(current_user, current_schema(), 'CREATE') AS can_create`,
  );
  const row = rows[0];
  if (row?.can_create === true) {
    throw new SchemaError('engine.runtimeAccount.ddlAllowed', { user: row.user }, locale);
  }
}
