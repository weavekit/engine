import type { Pool } from 'pg';
import type {
  IdentityDepartment,
  IdentityPullResult,
  IdentitySource,
  IdentityUser,
} from '../../../core/provider/identity/index.js';

/**
 * Declarative PostgreSQL identity source: reads a customer's own user /
 * department tables (read-only) and maps them to the normalized identity model.
 * The engine never writes these tables; `weave sync:identity` only reads them.
 */

/** user-table column mapping (`id` is required; the rest are optional) */
export interface PgIdentityUsersMap {
  table: string;
  id: string;
  name?: string;
  email?: string;
  mobile?: string;
  /** a scalar, a comma-separated string, or a text[] of roles */
  roles?: string;
  /** external id of the user's department */
  department?: string;
  /** external id of the user's direct manager */
  director?: string;
  enabled?: string;
}

/** department-table column mapping (`id` is required; the rest are optional) */
export interface PgIdentityDepartmentsMap {
  table: string;
  id: string;
  name?: string;
  code?: string;
  /** external id of the parent department */
  parent?: string;
  /** external id of the department head */
  manager?: string;
  enabled?: string;
}

export interface PgIdentitySourceConfig {
  /** value stored as `external_source`; defaults to `pg` */
  name?: string;
  users: PgIdentityUsersMap;
  departments: PgIdentityDepartmentsMap;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid SQL identifier "${name}"`);
  return `"${name}"`;
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value);
  return s === '' ? undefined : s;
}

function coerceEnabled(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 't', 'true', 'y', 'yes', 'active', 'enabled'].includes(s)) return true;
  if (['0', 'f', 'false', 'n', 'no', 'inactive', 'disabled', ''].includes(s)) return false;
  return undefined;
}

function coerceRoles(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v !== '');
  const s = String(value).trim();
  if (s === '') return undefined;
  return s
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export function createPgIdentitySource(config: PgIdentitySourceConfig, pool: Pool): IdentitySource {
  const name = config.name ?? 'pg';

  async function pull(): Promise<IdentityPullResult> {
    const u = config.users;
    const d = config.departments;

    const dCols = [`${ident(d.id)} AS "id"`];
    if (d.name !== undefined) dCols.push(`${ident(d.name)} AS "name"`);
    if (d.code !== undefined) dCols.push(`${ident(d.code)} AS "code"`);
    if (d.parent !== undefined) dCols.push(`${ident(d.parent)} AS "parent"`);
    if (d.manager !== undefined) dCols.push(`${ident(d.manager)} AS "manager"`);
    if (d.enabled !== undefined) dCols.push(`${ident(d.enabled)} AS "enabled"`);

    const uCols = [`${ident(u.id)} AS "id"`];
    if (u.name !== undefined) uCols.push(`${ident(u.name)} AS "name"`);
    if (u.email !== undefined) uCols.push(`${ident(u.email)} AS "email"`);
    if (u.mobile !== undefined) uCols.push(`${ident(u.mobile)} AS "mobile"`);
    if (u.roles !== undefined) uCols.push(`${ident(u.roles)} AS "roles"`);
    if (u.department !== undefined) uCols.push(`${ident(u.department)} AS "department"`);
    if (u.director !== undefined) uCols.push(`${ident(u.director)} AS "director"`);
    if (u.enabled !== undefined) uCols.push(`${ident(u.enabled)} AS "enabled"`);

    const deptRows = await pool.query(`SELECT ${dCols.join(', ')} FROM ${ident(d.table)}`);
    const userRows = await pool.query(`SELECT ${uCols.join(', ')} FROM ${ident(u.table)}`);

    const departments: IdentityDepartment[] = (deptRows.rows as Record<string, unknown>[]).map((row) => {
      const out: IdentityDepartment = { externalId: String(row.id) };
      const deptName = str(row.name);
      if (deptName !== undefined) out.name = deptName;
      const code = str(row.code);
      if (code !== undefined) out.code = code;
      const parent = str(row.parent);
      if (parent !== undefined) out.parentExternalId = parent;
      const manager = str(row.manager);
      if (manager !== undefined) out.managerExternalId = manager;
      const enabled = coerceEnabled(row.enabled);
      if (enabled !== undefined) out.enabled = enabled;
      return out;
    });

    const users: IdentityUser[] = (userRows.rows as Record<string, unknown>[]).map((row) => {
      const out: IdentityUser = { externalId: String(row.id) };
      const userName = str(row.name);
      if (userName !== undefined) out.name = userName;
      const email = str(row.email);
      if (email !== undefined) out.email = email;
      const mobile = str(row.mobile);
      if (mobile !== undefined) out.mobile = mobile;
      const roles = coerceRoles(row.roles);
      if (roles !== undefined) out.roles = roles;
      const department = str(row.department);
      if (department !== undefined) out.departmentExternalId = department;
      const director = str(row.director);
      if (director !== undefined) out.directorExternalId = director;
      const enabled = coerceEnabled(row.enabled);
      if (enabled !== undefined) out.enabled = enabled;
      return out;
    });

    return { users, departments };
  }

  return { name, capabilities: { deactivates: true }, pull };
}
